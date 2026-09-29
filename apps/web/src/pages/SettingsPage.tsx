import type { ChangePasswordRequest, Me, UpdateMeRequest } from '@hearth/shared';
import { useMutation, useQuery, useQueryClient, type UseMutationResult } from '@tanstack/react-query';
import { useState, type ChangeEvent, type SubmitEvent } from 'react';
import { changePassword, meQuery, updateMe } from '../api/auth';
import { errorMessage, fieldErrors } from '../api/errors';
import { FormAlert, FormSuccess, formString, TextField } from '../components/forms';
import { card, primaryButton } from '../components/styles';
import {
  notificationPermission,
  readNotificationsPref,
  requestNotificationPermission,
  writeNotificationsPref,
} from '../lib/notifications';

type ProfileMutation = UseMutationResult<Me, Error, UpdateMeRequest>;
type PasswordMutation = UseMutationResult<undefined, Error, ChangePasswordRequest>;

export function SettingsPage() {
  const { data: me } = useQuery(meQuery);
  const queryClient = useQueryClient();

  // Both mutations live here so that submitting one form resets the other: the page never shows more than
  // one role="alert" (same pattern as AdminInvitesPage).
  const profile: ProfileMutation = useMutation({
    mutationFn: updateMe,
    onSuccess: (user) => {
      queryClient.setQueryData(meQuery.queryKey, user);
    },
  });
  const password: PasswordMutation = useMutation({ mutationFn: changePassword });

  if (!me) return null;
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
      {/* Keyed so a different signed-in user never sees stale form values. */}
      <ProfileForm
        key={me.id}
        me={me}
        mutation={profile}
        onSubmitStart={() => {
          password.reset();
        }}
      />
      <PasswordForm
        mutation={password}
        onSubmitStart={() => {
          profile.reset();
        }}
      />
      <NotificationsSection />
    </div>
  );
}

const PERMISSION_HINTS = {
  denied: 'Notifications are blocked for this site. Allow them in your browser settings, then try again.',
  default: 'Notifications were not allowed.',
  unsupported: "This browser doesn't support desktop notifications.",
} as const;

/**
 * **Desktop notifications**: mentions and DMs while the tab is hidden (lib/notifications.ts).
 * Turning it on asks for permission first; it only stays on once permission is granted. The
 * preference is per browser (localStorage).
 */
function NotificationsSection() {
  const [enabled, setEnabled] = useState(
    () => readNotificationsPref() && notificationPermission() === 'granted',
  );
  const [hint, setHint] = useState<string | null>(null);
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
    if (!granted) setHint(PERMISSION_HINTS[permission]);
  };

  return (
    <section className={card} aria-labelledby="settings-notifications-heading">
      <h2 id="settings-notifications-heading" className="text-lg font-semibold">
        Notifications
      </h2>
      <p className="mt-1 text-sm text-muted">
        Get a desktop notification when someone mentions you or sends you a direct message while Hearth is in
        the background.
      </p>
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
          Desktop notifications
        </label>
      </div>
      {hint && <p className="mt-2 text-sm text-muted">{hint}</p>}
    </section>
  );
}

interface FormProps<M> {
  mutation: M;
  /** Called before this form's mutation starts (resets the other form's result). */
  onSubmitStart: () => void;
}

function ProfileForm({ me, mutation, onSubmitStart }: FormProps<ProfileMutation> & { me: Me }) {
  const onSubmit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    onSubmitStart();
    mutation.mutate({ displayName: formString(data, 'displayName').trim() });
  };

  const errors = fieldErrors(mutation.error);

  return (
    <section className={card} aria-labelledby="settings-profile-heading">
      <h2 id="settings-profile-heading" className="text-lg font-semibold">
        Profile
      </h2>
      <p className="mt-1 text-sm text-muted">
        Signed in as <span className="font-mono">{me.username}</span>
      </p>
      <form className="mt-4 flex max-w-sm flex-col gap-4" onSubmit={onSubmit} noValidate>
        <TextField
          id="settings-display-name"
          name="displayName"
          label="Display name"
          defaultValue={me.displayName}
          autoComplete="nickname"
          errors={errors}
        />
        <FormAlert message={mutation.isError ? errorMessage(mutation.error) : null} />
        {mutation.isSuccess && <FormSuccess>Profile saved.</FormSuccess>}
        <div>
          <button type="submit" className={primaryButton} disabled={mutation.isPending}>
            Save profile
          </button>
        </div>
      </form>
    </section>
  );
}

function PasswordForm({ mutation, onSubmitStart }: FormProps<PasswordMutation>) {
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
  const message = mutation.isError
    ? errorMessage(mutation.error, { INVALID_CREDENTIALS: 'Your current password is wrong.' })
    : null;

  return (
    <section className={card} aria-labelledby="settings-password-heading">
      <h2 id="settings-password-heading" className="text-lg font-semibold">
        Password
      </h2>
      <p className="mt-1 text-sm text-muted">Changing your password signs you out everywhere else.</p>
      <form className="mt-4 flex max-w-sm flex-col gap-4" onSubmit={onSubmit} noValidate>
        <TextField
          id="settings-current-password"
          name="currentPassword"
          label="Current password"
          type="password"
          autoComplete="current-password"
          errors={errors}
        />
        <TextField
          id="settings-new-password"
          name="newPassword"
          label="New password"
          type="password"
          autoComplete="new-password"
          placeholder="at least 10 characters"
          errors={errors}
        />
        <FormAlert message={message} />
        {mutation.isSuccess && <FormSuccess>Password changed.</FormSuccess>}
        <div>
          <button type="submit" className={primaryButton} disabled={mutation.isPending}>
            Change password
          </button>
        </div>
      </form>
    </section>
  );
}
