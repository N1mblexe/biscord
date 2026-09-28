import type { ChangePasswordRequest, Me, UpdateMeRequest } from '@hearth/shared';
import { useMutation, useQuery, useQueryClient, type UseMutationResult } from '@tanstack/react-query';
import type { SubmitEvent } from 'react';
import { changePassword, meQuery, updateMe } from '../api/auth';
import { errorMessage, fieldErrors } from '../api/errors';
import { FormAlert, FormSuccess, formString, TextField } from '../components/forms';
import { card, primaryButton } from '../components/styles';

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
    </div>
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
