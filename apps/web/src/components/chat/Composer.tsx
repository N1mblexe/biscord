import { LIMITS } from '@hearth/shared';
import { useState, type KeyboardEvent } from 'react';
import { errorMessage } from '../../api/errors';
import { deliverPending } from '../../lib/messageSync';
import { emitTyping, resetTypingThrottle } from '../../lib/typingEmit';
import { useSocket } from '../../socket/context';
import { useMessageStore } from '../../stores/messages';
import { inputClass, primaryButton } from '../styles';

interface ComposerProps {
  channelId: string;
  authorId: string;
  placeholder: string;
  /** Set when the channel can't be posted to (a DM with a deactivated user); shown as the placeholder. */
  disabledReason: string | null;
  onError: (message: string | null) => void;
}

/**
 * Message box: Enter sends, Shift+Enter adds a newline. Sends are optimistic (pending by nonce).
 * Typing announces `typing:start` (throttled, lib/typingEmit.ts).
 */
export function Composer({ channelId, authorId, placeholder, disabledReason, onError }: ComposerProps) {
  const [draft, setDraft] = useState('');
  const { socket } = useSocket();
  const disabled = disabledReason !== null;

  const send = () => {
    const content = draft.trim();
    if (disabled || content.length === 0) return;
    if (content.length > LIMITS.messageMaxChars) {
      onError(`Messages can be at most ${LIMITS.messageMaxChars} characters.`);
      return;
    }
    onError(null);
    const nonce = crypto.randomUUID();
    useMessageStore.getState().addPending({
      nonce,
      channelId,
      authorId,
      content,
      createdAt: new Date().toISOString(),
    });
    setDraft('');
    resetTypingThrottle(channelId);
    deliverPending(nonce).catch((err: unknown) => {
      onError(errorMessage(err));
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send();
    }
  };

  return (
    <form
      className="border-t border-white/5 px-4 py-3"
      onSubmit={(event) => {
        event.preventDefault();
        send();
      }}
    >
      <label htmlFor="composer-input" className="sr-only">
        Message
      </label>
      <div className="flex items-end gap-2">
        <textarea
          id="composer-input"
          name="content"
          className={`${inputClass} max-h-48 resize-none`}
          rows={Math.min(8, draft.split('\n').length)}
          maxLength={LIMITS.messageMaxChars}
          placeholder={disabledReason ?? placeholder}
          disabled={disabled}
          value={draft}
          // Focus follows the channel the user just opened.
          autoFocus
          onChange={(event) => {
            const value = event.target.value;
            setDraft(value);
            if (value.trim().length > 0) emitTyping(socket, channelId);
          }}
          onKeyDown={onKeyDown}
        />
        <button type="submit" className={primaryButton} disabled={disabled}>
          Send
        </button>
      </div>
    </form>
  );
}
