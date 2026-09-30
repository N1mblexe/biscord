import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { SubmitEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { meQuery, register } from '../api/auth';
import { fieldErrors, formAlertMessage } from '../api/errors';
import { AuthCard } from '../components/AuthCard';
import { FormAlert, formString, inlineLinkClass, TextField } from '../components/forms';
import { primaryButton } from '../components/styles';
import { normalizeUsername, USERNAME_RULE } from '../lib/username';

export function RegisterPage() {
  const [searchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const mutation = useMutation({
    mutationFn: register,
    onSuccess: (user) => {
      queryClient.setQueryData(meQuery.queryKey, user);
      void navigate('/', { replace: true });
    },
  });

  const onSubmit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    mutation.mutate({
      inviteCode: formString(data, 'inviteCode').trim(),
      username: normalizeUsername(formString(data, 'username')),
      displayName: formString(data, 'displayName').trim(),
      password: formString(data, 'password'),
    });
  };

  const errors = fieldErrors(mutation.error, { username: USERNAME_RULE });

  return (
    <AuthCard
      title="Create your account"
      description="You’ll need an invite code from one of the admins."
      footer={
        <p className="text-center text-sm text-muted">
          Already have an account?{' '}
          <Link to="/login" className={inlineLinkClass}>
            Log in instead
          </Link>
        </p>
      }
    >
      <form className="flex flex-col gap-4" onSubmit={onSubmit} noValidate>
        <TextField
          id="register-invite"
          name="inviteCode"
          label="Invite code"
          defaultValue={searchParams.get('invite') ?? ''}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          errors={errors}
        />
        <TextField
          id="register-username"
          name="username"
          label="Username"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          hint="3–32 lowercase letters, digits or underscores. Friends @mention you with it."
          errors={errors}
        />
        <TextField
          id="register-display-name"
          name="displayName"
          label="Display name"
          autoComplete="nickname"
          hint="What everyone sees. You can change it later in Settings."
          errors={errors}
        />
        <TextField
          id="register-password"
          name="password"
          label="Password"
          type="password"
          autoComplete="new-password"
          hint="At least 10 characters."
          errors={errors}
        />
        <FormAlert
          message={formAlertMessage(mutation.error, ['inviteCode', 'username', 'displayName', 'password'])}
        />
        <button
          type="submit"
          className={`${primaryButton} mt-1 w-full`}
          disabled={mutation.isPending}
          aria-busy={mutation.isPending}
        >
          Create account
        </button>
      </form>
    </AuthCard>
  );
}
