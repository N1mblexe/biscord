/** Login, register and reset-password pages (English, the source of truth). */
export const auth = {
  username: 'Username',
  password: 'Password',
  newPassword: 'New password',
  passwordHint: 'At least 10 characters.',
  login: {
    title: 'Welcome back',
    description: 'Log in to catch up with your friends.',
    haveInvite: 'Have an invite? <link>Create an account</link>',
    gotResetCode: 'Got a reset code? <link>Reset your password</link>',
    submit: 'Log in',
  },
  register: {
    title: 'Create your account',
    description: 'You’ll need an invite code from one of the admins.',
    haveAccount: 'Already have an account? <link>Log in instead</link>',
    inviteCode: 'Invite code',
    usernameHint: '3–32 lowercase letters, digits or underscores. Friends @mention you with it.',
    /** Replaces zod's per-check messages for an invalid username. */
    usernameRule: 'Use 3–32 lowercase letters, digits or underscores',
    displayName: 'Display name',
    displayNameHint: 'What everyone sees. You can change it later in Settings.',
    submit: 'Create account',
  },
  reset: {
    title: 'Reset your password',
    description: 'Ask an admin for a reset code. Codes are valid for 24 hours.',
    remembered: 'Remembered it? <link>Back to log in</link>',
    code: 'Reset code',
    submit: 'Set new password',
    invalidCredentials: 'Wrong username or reset code, or the code has expired.',
  },
  /** The login page's notice for `?reason=` (lib/authNotice.ts). */
  notice: {
    logout: 'You have been logged out.',
    deactivated: 'Your account has been deactivated.',
    password_changed: 'Your password was changed. Please log in again.',
    password_reset: 'Your password was reset. Please log in with your new password.',
    unauthenticated: 'Your session has ended. Please log in again.',
    generic: 'Please log in again.',
  },
} as const;
