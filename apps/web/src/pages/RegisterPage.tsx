import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { SubmitEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { meQuery, register } from '../api/auth';
import { fieldErrors, formAlertMessage } from '../api/errors';
import { AuthCard } from '../components/AuthCard';
import { FormAlert, formString, TextField } from '../components/forms';
import { linkClass, primaryButton } from '../components/styles';
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
    <AuthCard title="Create your account">
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
          placeholder="lowercase, digits, _"
          errors={errors}
        />
        <TextField
          id="register-display-name"
          name="displayName"
          label="Display name"
          autoComplete="nickname"
          errors={errors}
        />
        <TextField
          id="register-password"
          name="password"
          label="Password"
          type="password"
          autoComplete="new-password"
          placeholder="at least 10 characters"
          errors={errors}
        />
        <FormAlert
          message={formAlertMessage(mutation.error, ['inviteCode', 'username', 'displayName', 'password'])}
        />
        <button type="submit" className={primaryButton} disabled={mutation.isPending}>
          Create account
        </button>
      </form>
      <p className="mt-6 text-center text-sm text-muted">
        Already have an account?{' '}
        <Link to="/login" className={linkClass}>
          Log in instead
        </Link>
      </p>
    </AuthCard>
  );
}
