import { useMutation } from '@tanstack/react-query';
import type { SubmitEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { resetPassword } from '../api/auth';
import { fieldErrors, formAlertMessage } from '../api/errors';
import { AuthCard } from '../components/AuthCard';
import { FormAlert, formString, TextField } from '../components/forms';
import { linkClass, primaryButton } from '../components/styles';
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
    <AuthCard title="Reset your password">
      <p className="mb-4 text-sm text-muted">Ask an admin for a reset code. Codes are valid for 24 hours.</p>
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
          placeholder="at least 10 characters"
          errors={errors}
        />
        <FormAlert message={message} />
        <button type="submit" className={primaryButton} disabled={mutation.isPending}>
          Set new password
        </button>
      </form>
      <p className="mt-6 text-center text-sm text-muted">
        <Link to="/login" className={linkClass}>
          Back to log in
        </Link>
      </p>
    </AuthCard>
  );
}
