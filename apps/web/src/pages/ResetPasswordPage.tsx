import { useMutation } from '@tanstack/react-query';
import type { SubmitEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { resetPassword } from '../api/auth';
import { fieldErrors, formAlertMessage } from '../api/errors';
import { AuthCard } from '../components/AuthCard';
import { FormAlert, formString, inlineLinkClass, TextField } from '../components/forms';
import { primaryButton } from '../components/styles';
import { Trans } from '../i18n/Trans';
import { useT } from '../i18n/useT';
import { loginPathForReason } from '../lib/authNotice';

export function ResetPasswordPage() {
  const t = useT();
  const navigate = useNavigate();

  const mutation = useMutation({
    mutationFn: resetPassword,
    onSuccess: () => {
      void navigate(loginPathForReason('password_reset'), { replace: true });
    },
  });

  const onSubmit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    mutation.mutate({
      username: formString(data, 'username').trim(),
      code: formString(data, 'code').trim(),
      newPassword: formString(data, 'newPassword'),
    });
  };

  const errors = fieldErrors(mutation.error);
  const message = formAlertMessage(mutation.error, ['username', 'code', 'newPassword'], {
    INVALID_CREDENTIALS: t('auth.reset.invalidCredentials'),
  });

  return (
    <AuthCard
      title={t('auth.reset.title')}
      description={t('auth.reset.description')}
      footer={
        <p className="text-center text-sm text-muted">
          <Trans
            k="auth.reset.remembered"
            components={{
              link: (c) => (
                <Link to="/login" className={inlineLinkClass}>
                  {c}
                </Link>
              ),
            }}
          />
        </p>
      }
    >
      <form className="flex flex-col gap-4" onSubmit={onSubmit} noValidate>
        <TextField
          id="reset-username"
          name="username"
          label={t('auth.username')}
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          errors={errors}
        />
        <TextField
          id="reset-code-input"
          name="code"
          label={t('auth.reset.code')}
          autoComplete="one-time-code"
          autoCapitalize="characters"
          spellCheck={false}
          errors={errors}
        />
        <TextField
          id="reset-new-password"
          name="newPassword"
          label={t('auth.newPassword')}
          type="password"
          autoComplete="new-password"
          hint={t('auth.passwordHint')}
          errors={errors}
        />
        <FormAlert message={message} />
        <button
          type="submit"
          className={`${primaryButton} mt-1 w-full`}
          disabled={mutation.isPending}
          aria-busy={mutation.isPending}
        >
          {t('auth.reset.submit')}
        </button>
      </form>
    </AuthCard>
  );
}
