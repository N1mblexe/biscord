import { useMutation, useQuery } from '@tanstack/react-query';
import { useState, type SubmitEvent } from 'react';
import { generateResetCode, usersQuery } from '../api/admin';
import { errorMessage } from '../api/errors';
import { FormAlert, FormSuccess, formString, PageAlert } from '../components/forms';
import { card, inputClass, primaryButton } from '../components/styles';
import { usePageAlert } from '../components/usePageAlert';

export function AdminResetCodePage() {
  const users = useQuery(usersQuery);
  const [missingUser, setMissingUser] = useState(false);
  const mutation = useMutation({ mutationFn: generateResetCode });

  const onSubmit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const userId = formString(new FormData(event.currentTarget), 'userId');
    if (!userId) {
      mutation.reset();
      setMissingUser(true);
      return;
    }
    setMissingUser(false);
    mutation.mutate(userId);
  };

  const activeUsers = (users.data ?? []).filter((u) => !u.deactivated);
  const target = users.data?.find((u) => u.id === mutation.variables);
  const alert = missingUser
    ? 'Choose a user first.'
    : mutation.isError
      ? errorMessage(mutation.error)
      : users.isError
        ? errorMessage(users.error)
        : null;
  // The page's single alert slot, shared with the app-wide camera and screen share errors.
  const slot = usePageAlert(alert);

  return (
    <section className={card} aria-labelledby="reset-code-heading">
      <h1 id="reset-code-heading" className="text-2xl font-semibold tracking-tight">
        Reset codes
      </h1>
      <p className="mt-1 text-sm text-muted">
        Generate a one-time code a user can enter on the reset password page. It is shown once and expires
        after 24 hours; generating a new one invalidates older codes.
      </p>
      {slot.shared && (
        <div className="mt-4">
          <PageAlert message={slot.message} onDismiss={slot.dismiss} />
        </div>
      )}
      <form className="mt-4 flex max-w-sm flex-col gap-4" onSubmit={onSubmit} noValidate>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="reset-user" className="text-sm font-medium text-text">
            User
          </label>
          <select
            id="reset-user"
            name="userId"
            className={inputClass}
            defaultValue=""
            disabled={users.isPending}
          >
            <option value="" disabled>
              {users.isPending ? 'Loading users…' : 'Choose a user'}
            </option>
            {activeUsers.map((user) => (
              <option key={user.id} value={user.id}>
                {user.username}
              </option>
            ))}
          </select>
        </div>
        <FormAlert message={slot.shared ? null : slot.message} />
        <div>
          <button type="submit" className={primaryButton} disabled={mutation.isPending}>
            Generate reset code
          </button>
        </div>
      </form>
      {mutation.isSuccess && (
        <div className="mt-6">
          <FormSuccess>
            Reset code for <span className="font-semibold">{target?.username ?? 'the user'}</span>:{' '}
            <code data-testid="reset-code" className="font-mono text-base text-text select-all">
              {mutation.data.code}
            </code>
            <span className="mt-1 block text-xs text-muted">
              Expires{' '}
              {new Date(mutation.data.expiresAt).toLocaleString(undefined, {
                dateStyle: 'medium',
                timeStyle: 'short',
              })}
            </span>
          </FormSuccess>
        </div>
      )}
    </section>
  );
}
