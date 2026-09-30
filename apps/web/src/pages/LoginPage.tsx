import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { SubmitEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { login, meQuery } from '../api/auth';
import { fieldErrors, formAlertMessage } from '../api/errors';
import { AuthCard } from '../components/AuthCard';
import { FormAlert, formString, TextField } from '../components/forms';
import { ServerStatus } from '../components/ServerStatus';
import { linkClass, primaryButton } from '../components/styles';
import { authNoticeText } from '../lib/authNotice';
import { safeNext } from '../lib/redirects';

export function LoginPage() {
  const [searchParams] = useSearchParams();
  const notice = authNoticeText(searchParams.get('reason'));
  const next = safeNext(searchParams.get('next'));
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const mutation = useMutation({
    mutationFn: login,
    onSuccess: (user) => {
      queryClient.setQueryData(meQuery.queryKey, user);
      void navigate(next, { replace: true });
    },
  });

  const onSubmit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    mutation.mutate({ username: formString(data, 'username'), password: formString(data, 'password') });
  };

  const errors = fieldErrors(mutation.error);

  return (
    <AuthCard title="Log in to your account">
      {notice && (
        <p
          data-testid="auth-notice"
          className="mb-4 rounded-lg bg-accent/10 px-3 py-2 text-sm text-accent ring-1 ring-accent/30"
        >
          {notice}
        </p>
      )}
      <form className="flex flex-col gap-4" onSubmit={onSubmit} noValidate>
        <TextField
          id="login-username"
          name="username"
          label="Username"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          errors={errors}
        />
        <TextField
          id="login-password"
          name="password"
          label="Password"
          type="password"
          autoComplete="current-password"
          errors={errors}
        />
        <FormAlert message={formAlertMessage(mutation.error, ['username', 'password'])} />
        <button type="submit" className={primaryButton} disabled={mutation.isPending}>
          Log in
        </button>
      </form>
      <div className="mt-6 flex flex-col items-center gap-2 text-sm text-muted">
        <p>
          Have an invite?{' '}
          <Link to="/register" className={linkClass}>
            Create an account
          </Link>
        </p>
        <p>
          Got a reset code?{' '}
          <Link to="/reset-password" className={linkClass}>
            Reset your password
          </Link>
        </p>
      </div>
      <div className="mt-6 border-t border-white/5 pt-4">
        <ServerStatus />
      </div>
    </AuthCard>
  );
}
