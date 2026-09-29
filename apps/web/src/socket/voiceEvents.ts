import { VoiceLeftPayload, VoiceParticipantEventPayload } from '@hearth/shared';
import { useVoiceStore } from '../stores/voice';
import type { HearthSocket } from './socket';

/**
 * `voice:joined` / `voice:updated` / `voice:left` (CONTRACTS B.5) → the voice participants store.
 * The bootstrap refetch on every connect (chatEvents.ts) re-seeds it. Returns the unsubscribe function.
 */
export function registerVoiceEvents(socket: HearthSocket): () => void {
  const onUpsert = (type: 'joined' | 'updated') => (payload: unknown) => {
    const parsed = VoiceParticipantEventPayload.safeParse(payload);
    if (!parsed.success) return;
    useVoiceStore.getState().apply({ type, ...parsed.data });
  };
  const onJoined = onUpsert('joined');
  const onUpdated = onUpsert('updated');
  const onLeft = (payload: unknown) => {
    const parsed = VoiceLeftPayload.safeParse(payload);
    if (!parsed.success) return;
    useVoiceStore.getState().apply({ type: 'left', ...parsed.data });
  };

  socket.on('voice:joined', onJoined);
  socket.on('voice:updated', onUpdated);
  socket.on('voice:left', onLeft);
  return () => {
    socket.off('voice:joined', onJoined);
    socket.off('voice:updated', onUpdated);
    socket.off('voice:left', onLeft);
  };
}
