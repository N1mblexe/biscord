import type { InputHTMLAttributes, ReactNode } from 'react';
import type { FieldErrors } from '../api/errors';
import { inputClass } from './styles';

interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id' | 'name' | 'className'> {
  id: string;
  /** Also the request field name, used to look up VALIDATION field errors. */
  name: string;
  label: string;
  errors?: FieldErrors;
}

/** A labelled input (`<label htmlFor>`) with its VALIDATION messages underneath. */
export function TextField({ id, name, label, errors, ...inputProps }: TextFieldProps) {
  const messages = errors?.[name];
  const errorId = `${id}-error`;
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
        aria-describedby={messages ? errorId : undefined}
        {...inputProps}
      />
      {messages && (
        <p id={errorId} className="text-xs text-danger">
          {messages.join(' ')}
        </p>
      )}
    </div>
  );
}

/** The single `role="alert"` of a form. Renders nothing without a message. */
export function FormAlert({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger ring-1 ring-danger/30">
      {message}
    </p>
  );
}

/** A success message announced politely (`role="status"`). */
export function FormSuccess({ children }: { children: ReactNode }) {
  return (
    <p
      role="status"
      className="rounded-lg bg-success/10 px-3 py-2 text-sm text-success ring-1 ring-success/30"
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
      <div className="flex-1">
        <FormAlert message={message} />
      </div>
      <button
        type="button"
        aria-label="Dismiss error"
        className="rounded-md px-2 py-1.5 text-sm text-muted hover:bg-white/5 hover:text-text"
        onClick={onDismiss}
      >
        ×
      </button>
    </div>
  );
}
