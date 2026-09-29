import { addReaction, removeReaction } from '../api/chat';
import { useMessageStore } from '../stores/messages';

/** Requests per message+emoji run one after another, so the server sees the toggles in click order. */
const queues = new Map<string, Promise<void>>();

/**
 * Adds or removes our reaction: applied to the store at once, then sent (PUT/DELETE, both
 * idempotent). `reaction:added` / `reaction:removed` for the same change are no-ops afterwards. A
 * failed request reverts the optimistic change — only if there was one: when the store already had
 * that state (e.g. picking an emoji we had already reacted with), nothing is reverted — and rethrows
 * for the page's alert.
 */
export function setReaction(
  channelId: string,
  messageId: string,
  emoji: string,
  meId: string,
  add: boolean,
): Promise<void> {
  const changed = useMessageStore.getState().applyReaction(channelId, messageId, emoji, meId, add);

  const key = `${messageId}:${emoji}`;
  const previous = queues.get(key) ?? Promise.resolve();
  const request = previous
    .catch(() => undefined)
    .then(() => (add ? addReaction(messageId, emoji) : removeReaction(messageId, emoji)))
    .then(
      () => undefined,
      (err: unknown) => {
        if (changed) useMessageStore.getState().applyReaction(channelId, messageId, emoji, meId, !add);
        throw err;
      },
    );
  queues.set(key, request);
  const cleanup = () => {
    if (queues.get(key) === request) queues.delete(key);
  };
  void request.then(cleanup, cleanup);
  return request;
}
