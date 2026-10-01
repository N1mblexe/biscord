import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { SubmitEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { meQuery, register } from '../api/auth';
import { fieldErrors, formAlertMessage } from '../api/errors';
import { AuthCard } from '../components/AuthCard';
import { FormAlert, formString, inlineLinkClass, TextField } from '../components/forms';
import { primaryButton } from '../components/styles';
import { Trans } from '../i18n/Trans';
import { useLocale, useT } from '../i18n/useT';
import { normalizeUsername, usernameRule } from '../lib/username';

export function RegisterPage() {
  const t = useT();
  // Sent with the account, so it is created in the language shown (CONTRACTS B.11 rule 3).
  const [locale] = useLocale();
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
      locale,
    });
  };

  const errors = fieldErrors(mutation.error, { username: usernameRule() });

  return (
    <AuthCard
      title={t('auth.register.title')}
      description={t('auth.register.description')}
      footer={
        <p className="text-center text-sm text-muted">
          <Trans
            k="auth.register.haveAccount"
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
          id="register-invite"
          name="inviteCode"
          label={t('auth.register.inviteCode')}
          defaultValue={searchParams.get('invite') ?? ''}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          errors={errors}
        />
        <TextField
          id="register-username"
          name="username"
          label={t('auth.username')}
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          hint={t('auth.register.usernameHint')}
          errors={errors}
        />
        <TextField
          id="register-display-name"
          name="displayName"
          label={t('auth.register.displayName')}
          autoComplete="nickname"
          hint={t('auth.register.displayNameHint')}
          errors={errors}
        />
        <TextField
          id="register-password"
          name="password"
          label={t('auth.password')}
          type="password"
          autoComplete="new-password"
          hint={t('auth.passwordHint')}
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
          {t('auth.register.submit')}
        </button>
      </form>
    </AuthCard>
  );
}
