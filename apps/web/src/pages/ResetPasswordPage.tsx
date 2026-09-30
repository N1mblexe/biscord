import { useMutation } from '@tanstack/react-query';
import type { SubmitEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { resetPassword } from '../api/auth';
import { fieldErrors, formAlertMessage } from '../api/errors';
import { AuthCard } from '../components/AuthCard';
import { FormAlert, formString, inlineLinkClass, TextField } from '../components/forms';
import { primaryButton } from '../components/styles';
import { loginPathForReason } from '../lib/authNotice';

export function ResetPasswordPage() {
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
    INVALID_CREDENTIALS: 'Wrong username or reset code, or the code has expired.',
  });

  return (
    <AuthCard
      title="Reset your password"
      description="Ask an admin for a reset code. Codes are valid for 24 hours."
      footer={
        <p className="text-center text-sm text-muted">
          Remembered it?{' '}
          <Link to="/login" className={inlineLinkClass}>
            Back to log in
          </Link>
        </p>
      }
    >
      <form className="flex flex-col gap-4" onSubmit={onSubmit} noValidate>
        <TextField
          id="reset-username"
          name="username"
          label="Username"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          errors={errors}
        />
        <TextField
          id="reset-code-input"
          name="code"
          label="Reset code"
          autoComplete="one-time-code"
          autoCapitalize="characters"
          spellCheck={false}
          errors={errors}
        />
        <TextField
          id="reset-new-password"
          name="newPassword"
          label="New password"
          type="password"
          autoComplete="new-password"
          hint="At least 10 characters."
          errors={errors}
        />
        <FormAlert message={message} />
        <button
          type="submit"
          className={`${primaryButton} mt-1 w-full`}
          disabled={mutation.isPending}
          aria-busy={mutation.isPending}
        >
          Set new password
        </button>
      </form>
    </AuthCard>
  );
}
