import type { PublicUser } from '@hearth/shared';
import { useLocale } from '../../i18n';
import { authorName } from '../../lib/bootstrapPatch';
import { NOBODY_TYPING, typingText, useTypingStore } from '../../stores/typing';

interface TypingIndicatorProps {
  channelId: string;
  meId: string;
  usersById: ReadonlyMap<string, PublicUser>;
}

/**
 * "Alice is typing…" above the composer (`data-testid="typing-indicator"`, absent when nobody is
 * typing). The row keeps its height so the history doesn't jump.
 */
export function TypingIndicator({ channelId, meId, usersById }: TypingIndicatorProps) {
  // Re-renders on a language change (`typingText` reads the current language).
  useLocale();
  const userIds = useTypingStore((s) => s.byChannel[channelId] ?? NOBODY_TYPING);
  const names = userIds.filter((id) => id !== meId).map((id) => authorName(usersById.get(id)));
  const text = typingText(names);
  return (
    <div aria-live="polite" className="h-5 shrink-0 truncate px-4 text-xs text-muted">
      {text !== null && <span data-testid="typing-indicator">{text}</span>}
    </div>
  );
}
