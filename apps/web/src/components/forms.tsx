import type { InputHTMLAttributes, ReactNode } from 'react';
import type { FieldErrors } from '../api/errors';
import { inputClass } from './styles';

/**
 * A link inside a sentence: underlined, because accent and the surrounding text differ mostly in
 * hue, not lightness (WCAG 1.4.1).
 */
export const inlineLinkClass =
  'rounded-sm font-medium text-accent underline decoration-accent/40 underline-offset-4 transition ' +
  'hover:decoration-accent';

interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id' | 'name' | 'className'> {
  id: string;
  /** Also the request field name, used to look up VALIDATION field errors. */
  name: string;
  label: string;
  errors?: FieldErrors;
  /** Help shown under the input (e.g. "At least 10 characters"), linked with `aria-describedby`. */
  hint?: ReactNode;
}

/**
 * A labelled input (`<label htmlFor>`) with an optional hint and its VALIDATION messages
 * underneath; both are announced with the input (`aria-describedby`).
 */
export function TextField({ id, name, label, errors, hint, ...inputProps }: TextFieldProps) {
  const messages = errors?.[name];
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;
  const describedBy = [hint ? hintId : null, messages ? errorId : null].filter(Boolean).join(' ');
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-text">
        {label}
      </label>
      <input
        id={id}
        name={name}
        className={inputClass}
        aria-invalid={messages ? true : undefined}
        aria-describedby={describedBy || undefined}
        {...inputProps}
      />
      {hint && !messages && (
        <p id={hintId} className="text-xs text-muted">
          {hint}
        </p>
      )}
      {messages && (
        <p id={errorId} className="flex items-start gap-1 text-xs text-danger">
          <AlertIcon className="mt-px size-3.5" />
          <span>{messages.join(' ')}</span>
        </p>
      )}
    </div>
  );
}

function AlertIcon({ className }: { className: string }) {
  return (
    <svg viewBox="0 0 16 16" className={`shrink-0 ${className}`} fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeWidth="1.5" />
      <path d="M8 4.75v3.75" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="8" cy="11" r="0.9" fill="currentColor" />
    </svg>
  );
}

/** The single `role="alert"` of a form. Renders nothing without a message. */
export function FormAlert({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p
      role="alert"
      className="flex items-start gap-2 rounded-control bg-danger/10 px-3 py-2 text-sm text-danger ring-1 ring-danger/30"
    >
      <AlertIcon className="mt-0.5 size-4" />
      <span>{message}</span>
    </p>
  );
}

/** A success message announced politely (`role="status"`). */
export function FormSuccess({ children }: { children: ReactNode }) {
  return (
    <p
      role="status"
      className="rounded-control bg-success/10 px-3 py-2 text-sm text-success ring-1 ring-success/30"
    >
      {children}
    </p>
  );
}

/** Reads a text field from submitted form data (`''` when missing). */
export function formString(data: FormData, name: string): string {
  const value = data.get(name);
  return typeof value === 'string' ? value : '';
}

/** A page's single `role="alert"` with a dismiss button. Renders nothing without a message. */
export function PageAlert({ message, onDismiss }: { message: string | null; onDismiss: () => void }) {
  if (!message) return null;
  return (
    <div className="flex items-start gap-2">
      <div className="min-w-0 flex-1">
        <FormAlert message={message} />
      </div>
      <button
        type="button"
        aria-label="Dismiss error"
        className="inline-flex size-9 shrink-0 items-center justify-center rounded-control text-muted transition hover:bg-white/5 hover:text-text"
        onClick={onDismiss}
      >
        <svg viewBox="0 0 16 16" className="size-4" fill="none" aria-hidden="true">
          <path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}
