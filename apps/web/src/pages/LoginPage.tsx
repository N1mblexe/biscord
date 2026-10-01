import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { SubmitEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { login, meQuery } from '../api/auth';
import { fieldErrors, formAlertMessage } from '../api/errors';
import { AuthCard } from '../components/AuthCard';
import { FormAlert, formString, inlineLinkClass, TextField } from '../components/forms';
import { ServerStatus } from '../components/ServerStatus';
import { primaryButton } from '../components/styles';
import { Trans } from '../i18n/Trans';
import { useT } from '../i18n/useT';
import { authNoticeText } from '../lib/authNotice';
import { safeNext } from '../lib/redirects';

export function LoginPage() {
  const t = useT();
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
    <AuthCard
      title={t('auth.login.title')}
      description={t('auth.login.description')}
      footer={
        <div className="flex flex-col items-center gap-4">
          <div className="flex flex-col items-center gap-1.5 text-center text-sm text-muted">
            <p>
              <Trans
                k="auth.login.haveInvite"
                components={{
                  link: (c) => (
                    <Link to="/register" className={inlineLinkClass}>
                      {c}
                    </Link>
                  ),
                }}
              />
            </p>
            <p>
              <Trans
                k="auth.login.gotResetCode"
                components={{
                  link: (c) => (
                    <Link to="/reset-password" className={inlineLinkClass}>
                      {c}
                    </Link>
                  ),
                }}
              />
            </p>
          </div>
          <ServerStatus />
        </div>
      }
    >
      {notice && (
        <p
          data-testid="auth-notice"
          className="mb-5 rounded-control bg-accent/10 px-3 py-2 text-sm text-accent ring-1 ring-accent/30"
        >
          {notice}
        </p>
      )}
      <form className="flex flex-col gap-4" onSubmit={onSubmit} noValidate>
        <TextField
          id="login-username"
          name="username"
          label={t('auth.username')}
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          errors={errors}
        />
        <TextField
          id="login-password"
          name="password"
          label={t('auth.password')}
          type="password"
          autoComplete="current-password"
          errors={errors}
        />
        <FormAlert message={formAlertMessage(mutation.error, ['username', 'password'])} />
        <button
          type="submit"
          className={`${primaryButton} mt-1 w-full`}
          disabled={mutation.isPending}
          aria-busy={mutation.isPending}
        >
          {t('auth.login.submit')}
        </button>
      </form>
    </AuthCard>
  );
}
