import {
  AVATAR_MIME_TYPES,
  LIMITS,
  type BootstrapResponse,
  type ChangePasswordRequest,
  type Locale,
  type Me,
  type UpdateMeRequest,
} from '@hearth/shared';
import { useMutation, useQuery, useQueryClient, type UseMutationResult } from '@tanstack/react-query';
import { useState, type ChangeEvent, type SubmitEvent } from 'react';
import { changePassword, meQuery, updateMe } from '../api/auth';
import { bootstrapQueryKey } from '../api/chat';
import { errorMessage, fieldErrors, formAlertMessage } from '../api/errors';
import { removeAvatar, setAvatar } from '../api/uploads';
import { Avatar } from '../components/Avatar';
import {
  FormAlert,
  FormSuccess,
  formString,
  LanguageOptions,
  PageAlert,
  TextField,
} from '../components/forms';
import { card, inputClass, primaryButton, secondaryButton } from '../components/styles';
import { usePageAlert } from '../components/usePageAlert';
import { isLocale } from '../i18n/detect';
import { formatBytes } from '../i18n/format';
import { getLocale } from '../i18n/store';
import { Trans } from '../i18n/Trans';
import { useLocale, useT } from '../i18n/useT';
import { avatarUploadError, checkAvatarFile } from '../lib/avatar';
import { upsertUser } from '../lib/bootstrapPatch';
import {
  notificationPermission,
  type PermissionState,
  readNotificationsPref,
  requestNotificationPermission,
  writeNotificationsPref,
} from '../lib/notifications';

type ProfileMutation = UseMutationResult<Me, Error, UpdateMeRequest>;
type PasswordMutation = UseMutationResult<undefined, Error, ChangePasswordRequest>;
type AvatarMutation = UseMutationResult<Me, Error, File>;
type RemoveAvatarMutation = UseMutationResult<Me, Error, void>;
type LanguageMutation = UseMutationResult<Me, Error, Locale, { previous: Locale }>;
type Form = 'profile' | 'password' | 'avatar' | 'language';

export function SettingsPage() {
  const t = useT();
  const [, setLocale] = useLocale();
  const { data: me } = useQuery(meQuery);
  const queryClient = useQueryClient();

  // Our own user in the caches the header, members list and messages read from. The server also
  // broadcasts `user:updated`, which patches the same caches (idempotently).
  const storeMe = (user: Me) => {
    queryClient.setQueryData(meQuery.queryKey, user);
    const { id, username, displayName, avatarUrl, role, deactivated } = user;
    queryClient.setQueryData<BootstrapResponse>(bootstrapQueryKey, (boot) =>
      boot ? upsertUser(boot, { id, username, displayName, avatarUrl, role, deactivated }) : boot,
    );
  };

  // Every mutation lives here so that starting one resets the others: the page never shows more than
  // one role="alert" (same pattern as AdminInvitesPage).
  const profile: ProfileMutation = useMutation({ mutationFn: updateMe, onSuccess: storeMe });
  const password: PasswordMutation = useMutation({ mutationFn: changePassword });
  const avatarSet: AvatarMutation = useMutation({ mutationFn: setAvatar, onSuccess: storeMe });
  const avatarRemove: RemoveAvatarMutation = useMutation({ mutationFn: removeAvatar, onSuccess: storeMe });
  // The language switches at once and is then saved to the account; a failed save switches back.
  const language: LanguageMutation = useMutation({
    mutationFn: (locale: Locale) => updateMe({ locale }),
    onMutate: (locale) => {
      const previous = getLocale();
      setLocale(locale);
      return { previous };
    },
    onError: (_err, locale, context) => {
      // Only if nothing switched it again since.
      if (context && getLocale() === locale) setLocale(context.previous);
    },
    onSuccess: storeMe,
  });
  // The avatar pre-check's alert (wrong type or too big), shown instead of a request.
  const [avatarCheck, setAvatarCheck] = useState<string | null>(null);

  const resetAllBut = (keep: Form) => {
    if (keep !== 'profile') profile.reset();
    if (keep !== 'password') password.reset();
    if (keep !== 'avatar') setAvatarCheck(null);
    if (keep !== 'language') language.reset();
    avatarSet.reset();
    avatarRemove.reset();
  };

  // The page's single alert slot: at most one form has failed (see above), and the app-wide camera
  // and screen share errors share the slot with it (the newer one is shown).
  const avatarFailed = avatarSet.isError ? avatarSet.error : avatarRemove.isError ? avatarRemove.error : null;
  const avatarMessage = avatarCheck ?? (avatarFailed ? avatarUploadError(avatarFailed) : null);
  const own: { form: Form; message: string | null } | null = profile.isError
    ? { form: 'profile', message: formAlertMessage(profile.error, ['displayName']) }
    : password.isError
      ? {
          form: 'password',
          message: formAlertMessage(password.error, ['currentPassword', 'newPassword'], {
            INVALID_CREDENTIALS: t('settings.password.wrongCurrent'),
          }),
        }
      : avatarMessage !== null
        ? { form: 'avatar', message: avatarMessage }
        : language.isError
          ? { form: 'language', message: errorMessage(language.error) }
          : null;
  const slot = usePageAlert(own?.message ?? null);
  const alertFor = (form: Form) => (!slot.shared && own?.form === form ? slot.message : null);

  if (!me) return null;
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">{t('settings.title')}</h1>
      {slot.shared && <PageAlert message={slot.message} onDismiss={slot.dismiss} />}
      {/* Keyed so a different signed-in user never sees stale form values. */}
      <ProfileForm
        key={me.id}
        me={me}
        mutation={profile}
        alert={alertFor('profile')}
        onSubmitStart={() => {
          resetAllBut('profile');
        }}
      />
      <AvatarSection
        me={me}
        setMutation={avatarSet}
        removeMutation={avatarRemove}
        alert={alertFor('avatar')}
        onStart={(checkError) => {
          resetAllBut('avatar');
          setAvatarCheck(checkError);
        }}
      />
      <PasswordForm
        mutation={password}
        alert={alertFor('password')}
        onSubmitStart={() => {
          resetAllBut('password');
        }}
      />
      <NotificationsSection />
      <LanguageSection
        mutation={language}
        alert={alertFor('language')}
        onSubmitStart={() => {
          resetAllBut('language');
        }}
      />
    </div>
  );
}

/**
 * **Avatar** (docs/plans/phase-5.md, "Web UI contract"): picking a file uploads it at once after a
 * type and size pre-check; **Remove avatar** only while one is set. The change reaches everyone
 * through `user:updated`.
 */
function AvatarSection({
  me,
  setMutation,
  removeMutation,
  alert,
  onStart,
}: {
  me: Me;
  setMutation: AvatarMutation;
  removeMutation: RemoveAvatarMutation;
  /** This section's share of the page's single alert (the pre-check or upload error). */
  alert: string | null;
  /** Resets the other forms' results; `checkError` is the pre-check alert (or `null` to go ahead). */
  onStart: (checkError: string | null) => void;
}) {
  const t = useT();
  const busy = setMutation.isPending || removeMutation.isPending;

  const onChange = (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const file = input.files?.[0];
    // Lets the same file be picked again.
    input.value = '';
    if (!file) return;
    const problem = checkAvatarFile(file);
    onStart(problem);
    if (problem === null) setMutation.mutate(file);
  };

  return (
    <section className={`${card} max-md:p-4`}>
      <h2 className="text-lg font-semibold">{t('settings.avatar.heading')}</h2>
      <p className="mt-1 text-sm text-muted">
        {t('settings.avatar.description', { size: formatBytes(LIMITS.avatarMaxBytes) })}
      </p>
      <div className="mt-4 flex max-w-sm flex-col gap-4">
        <div className="flex items-center gap-4">
          <Avatar userId={me.id} name={me.displayName} avatarUrl={me.avatarUrl} size="lg" />
          <div className="flex flex-col gap-2 max-md:min-w-0 max-md:flex-1">
            <label htmlFor="settings-avatar" className="text-sm font-medium">
              {t('settings.avatar.label')}
            </label>
            <input
              id="settings-avatar"
              name="avatar"
              type="file"
              accept={AVATAR_MIME_TYPES.join(',')}
              disabled={busy}
              className="text-sm text-muted max-md:w-full max-md:min-w-0 file:mr-3 file:rounded-lg file:border-0 file:bg-surface-raised file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-text file:ring-1 file:ring-white/10 hover:file:bg-white/10"
              onChange={onChange}
            />
          </div>
        </div>
        <FormAlert message={alert} />
        {setMutation.isSuccess && <FormSuccess>{t('settings.avatar.updated')}</FormSuccess>}
        {removeMutation.isSuccess && <FormSuccess>{t('settings.avatar.removed')}</FormSuccess>}
        {me.avatarUrl !== null && (
          <div>
            <button
              type="button"
              className={secondaryButton}
              disabled={busy}
              onClick={() => {
                onStart(null);
                removeMutation.mutate();
              }}
            >
              {t('settings.avatar.remove')}
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

/** The hint shown when turning notifications on didn't get permission. */
const PERMISSION_HINTS = {
  denied: 'settings.notifications.denied',
  default: 'settings.notifications.default',
  unsupported: 'settings.notifications.unsupported',
} as const satisfies Record<Exclude<PermissionState, 'granted'>, string>;

/**
 * **Desktop notifications**: mentions and DMs while the tab is hidden (lib/notifications.ts).
 * Turning it on asks for permission first; it only stays on once permission is granted. The
 * preference is per browser (localStorage).
 */
function NotificationsSection() {
  const t = useT();
  const [enabled, setEnabled] = useState(
    () => readNotificationsPref() && notificationPermission() === 'granted',
  );
  const [hint, setHint] = useState<keyof typeof PERMISSION_HINTS | null>(null);
  const [asking, setAsking] = useState(false);

  const onChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const wanted = event.target.checked;
    setHint(null);
    if (!wanted) {
      writeNotificationsPref(false);
      setEnabled(false);
      return;
    }
    setAsking(true);
    const permission = await requestNotificationPermission();
    setAsking(false);
    const granted = permission === 'granted';
    writeNotificationsPref(granted);
    setEnabled(granted);
    if (permission !== 'granted') setHint(permission);
  };

  return (
    <section className={`${card} max-md:p-4`} aria-labelledby="settings-notifications-heading">
      <h2 id="settings-notifications-heading" className="text-lg font-semibold">
        {t('settings.notifications.heading')}
      </h2>
      <p className="mt-1 text-sm text-muted">{t('settings.notifications.description')}</p>
      <div className="mt-4 flex items-center gap-2">
        <input
          id="settings-desktop-notifications"
          type="checkbox"
          className="size-4 accent-accent"
          checked={enabled}
          disabled={asking}
          onChange={(event) => {
            void onChange(event);
          }}
        />
        <label htmlFor="settings-desktop-notifications" className="text-sm font-medium">
          {t('settings.notifications.label')}
        </label>
      </div>
      {hint && <p className="mt-2 text-sm text-muted">{t(PERMISSION_HINTS[hint])}</p>}
    </section>
  );
}

interface FormProps<M> {
  mutation: M;
  /** This form's share of the page's single alert. */
  alert: string | null;
  /** Called before this form's mutation starts (resets the other form's result). */
  onSubmitStart: () => void;
}

function ProfileForm({ me, mutation, alert, onSubmitStart }: FormProps<ProfileMutation> & { me: Me }) {
  const t = useT();
  const onSubmit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    onSubmitStart();
    mutation.mutate({ displayName: formString(data, 'displayName').trim() });
  };

  const errors = fieldErrors(mutation.error);

  return (
    <section className={`${card} max-md:p-4`} aria-labelledby="settings-profile-heading">
      <h2 id="settings-profile-heading" className="text-lg font-semibold">
        {t('settings.profile.heading')}
      </h2>
      <p className="mt-1 text-sm text-muted">
        <Trans
          k="settings.profile.signedInAs"
          params={{ username: me.username }}
          components={{ mono: (c) => <span className="font-mono">{c}</span> }}
        />
      </p>
      <form className="mt-4 flex max-w-sm flex-col gap-4" onSubmit={onSubmit} noValidate>
        <TextField
          id="settings-display-name"
          name="displayName"
          label={t('settings.profile.displayName')}
          defaultValue={me.displayName}
          autoComplete="nickname"
          errors={errors}
        />
        <FormAlert message={alert} />
        {mutation.isSuccess && <FormSuccess>{t('settings.profile.saved')}</FormSuccess>}
        <div>
          <button type="submit" className={primaryButton} disabled={mutation.isPending}>
            {t('settings.profile.submit')}
          </button>
        </div>
      </form>
    </section>
  );
}

function PasswordForm({ mutation, alert, onSubmitStart }: FormProps<PasswordMutation>) {
  const t = useT();
  const onSubmit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    onSubmitStart();
    mutation.mutate(
      { currentPassword: formString(data, 'currentPassword'), newPassword: formString(data, 'newPassword') },
      {
        onSuccess: () => {
          form.reset();
        },
      },
    );
  };

  const errors = fieldErrors(mutation.error);

  return (
    <section className={`${card} max-md:p-4`} aria-labelledby="settings-password-heading">
      <h2 id="settings-password-heading" className="text-lg font-semibold">
        {t('settings.password.heading')}
      </h2>
      <p className="mt-1 text-sm text-muted">{t('settings.password.description')}</p>
      <form className="mt-4 flex max-w-sm flex-col gap-4" onSubmit={onSubmit} noValidate>
        <TextField
          id="settings-current-password"
          name="currentPassword"
          label={t('settings.password.current')}
          type="password"
          autoComplete="current-password"
          errors={errors}
        />
        <TextField
          id="settings-new-password"
          name="newPassword"
          label={t('settings.password.new')}
          type="password"
          autoComplete="new-password"
          placeholder={t('settings.password.placeholder')}
          errors={errors}
        />
        <FormAlert message={alert} />
        {mutation.isSuccess && <FormSuccess>{t('settings.password.changed')}</FormSuccess>}
        <div>
          <button type="submit" className={primaryButton} disabled={mutation.isPending}>
            {t('settings.password.submit')}
          </button>
        </div>
      </form>
    </section>
  );
}

/**
 * **Language** (CONTRACTS B.11): the UI language, saved to the account. Changing it switches at once,
 * then PATCHes `/me`; "Language updated." confirms the save, and a failure switches back and shows
 * the page's alert here.
 */
function LanguageSection({ mutation, alert, onSubmitStart }: FormProps<LanguageMutation>) {
  const t = useT();
  const [locale] = useLocale();
  return (
    <section className={`${card} max-md:p-4`} aria-labelledby="settings-language-heading">
      <h2
        id="settings-language-heading"
        data-testid="settings-language-heading"
        className="text-lg font-semibold"
      >
        {t('settings.language.heading')}
      </h2>
      <p className="mt-1 text-sm text-muted">{t('settings.language.description')}</p>
      <div className="mt-4 flex max-w-sm flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="settings-language" className="text-sm font-medium text-text">
            {t('common.language.label')}
          </label>
          <select
            id="settings-language"
            data-testid="language-select"
            className={inputClass}
            value={locale}
            aria-busy={mutation.isPending}
            onChange={(event) => {
              const next = event.target.value;
              if (!isLocale(next) || next === locale) return;
              onSubmitStart();
              mutation.mutate(next);
            }}
          >
            <LanguageOptions />
          </select>
        </div>
        <FormAlert message={alert} />
        {mutation.isSuccess && <FormSuccess>{t('settings.language.updated')}</FormSuccess>}
      </div>
    </section>
  );
}
