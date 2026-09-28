import {
  ChannelDeletedPayload,
  ChannelEventPayload,
  ChannelsReorderedPayload,
  DmCreatedPayload,
  MessageDeletedPayload,
  MessageEventPayload,
  UserUpdatedPayload,
  type BootstrapResponse,
} from '@hearth/shared';
import type { QueryClient } from '@tanstack/react-query';
import { matchPath } from 'react-router';
import { bootstrapQueryKey } from '../api/chat';
import { removeChannel, replaceChannels, upsertChannel, upsertDm, upsertUser } from '../lib/bootstrapPatch';
import { catchUpAll, receiveCreated, receiveUpdated, setSocketConnected } from '../lib/messageSync';
import { useMessageStore } from '../stores/messages';
import { NOTICES, useNoticeStore } from '../stores/notice';
import type { HearthSocket } from './socket';

export interface ChatEventDeps {
  queryClient: QueryClient;
  /** Router navigation (to `/` when the open channel is deleted). */
  navigate: (to: string) => void;
}

/** The channel id of the page currently shown, if it is `/channels/:channelId`. */
function currentChannelId(): string | null {
  return matchPath('/channels/:channelId', window.location.pathname)?.params.channelId ?? null;
}

/**
 * Chat realtime wiring (CONTRACTS B.5):
 * - `message:*` → the message store, only for channels that have a store entry (opened this
 *   session); other channels are ignored until unread badges (Phase 4). `message:updated` only
 *   replaces messages that are loaded.
 * - `channel:*`, `channels:reordered`, `dm:created`, `user:updated` → the cached `['bootstrap']`.
 * - Every connect, including the first (history or bootstrap may have been fetched before the socket
 *   joined its rooms), and the browser coming back online: refetch bootstrap and catch up every
 *   opened channel from its `syncedThrough` cursor (lib/messageSync.ts). Both are idempotent.
 * Returns the unsubscribe function.
 */
export function registerChatEvents(
  socket: HearthSocket,
  { queryClient, navigate }: ChatEventDeps,
): () => void {
  const messages = () => useMessageStore.getState();
  const patchBootstrap = (fn: (boot: BootstrapResponse) => BootstrapResponse) => {
    queryClient.setQueryData<BootstrapResponse>(bootstrapQueryKey, (boot) => (boot ? fn(boot) : boot));
  };

  const onMessageCreated = (payload: unknown) => {
    const parsed = MessageEventPayload.safeParse(payload);
    if (parsed.success) receiveCreated(parsed.data.message);
  };
  const onMessageUpdated = (payload: unknown) => {
    const parsed = MessageEventPayload.safeParse(payload);
    if (parsed.success) receiveUpdated(parsed.data.message);
  };
  const onMessageDeleted = (payload: unknown) => {
    const parsed = MessageDeletedPayload.safeParse(payload);
    if (!parsed.success) return;
    messages().remove(parsed.data.channelId, parsed.data.messageId);
  };

  const onChannelUpsert = (payload: unknown) => {
    const parsed = ChannelEventPayload.safeParse(payload);
    if (!parsed.success) return;
    patchBootstrap((boot) => upsertChannel(boot, parsed.data.channel));
  };
  const onChannelDeleted = (payload: unknown) => {
    const parsed = ChannelDeletedPayload.safeParse(payload);
    if (!parsed.success) return;
    const { channelId } = parsed.data;
    const viewing = currentChannelId() === channelId;
    if (viewing) {
      useNoticeStore.getState().setNotice(NOTICES.channelDeleted);
      navigate('/');
    }
    patchBootstrap((boot) => removeChannel(boot, channelId));
    messages().forgetChannel(channelId);
  };
  const onChannelsReordered = (payload: unknown) => {
    const parsed = ChannelsReorderedPayload.safeParse(payload);
    if (!parsed.success) return;
    patchBootstrap((boot) => replaceChannels(boot, parsed.data.channels));
  };
  const onDmCreated = (payload: unknown) => {
    const parsed = DmCreatedPayload.safeParse(payload);
    if (!parsed.success) return;
    patchBootstrap((boot) => upsertDm(boot, parsed.data.channel));
  };
  const onUserUpdated = (payload: unknown) => {
    const parsed = UserUpdatedPayload.safeParse(payload);
    if (!parsed.success) return;
    patchBootstrap((boot) => upsertUser(boot, parsed.data.user));
  };

  const catchUp = () => {
    void queryClient.invalidateQueries({ queryKey: bootstrapQueryKey });
    void catchUpAll();
  };
  const onConnect = () => {
    setSocketConnected(true);
    catchUp();
  };
  const onDisconnect = () => {
    setSocketConnected(false);
  };
  // A socket that survived an offline spell may have missed nothing — or may not have noticed the
  // outage yet. Catching up is idempotent, so do it whenever the browser is back online.
  const onOnline = () => {
    if (socket.connected) catchUp();
  };

  socket.on('connect', onConnect);
  socket.on('disconnect', onDisconnect);
  socket.on('message:created', onMessageCreated);
  socket.on('message:updated', onMessageUpdated);
  socket.on('message:deleted', onMessageDeleted);
  socket.on('channel:created', onChannelUpsert);
  socket.on('channel:updated', onChannelUpsert);
  socket.on('channel:deleted', onChannelDeleted);
  socket.on('channels:reordered', onChannelsReordered);
  socket.on('dm:created', onDmCreated);
  socket.on('user:updated', onUserUpdated);
  window.addEventListener('online', onOnline);
  // Registered on an already-connected socket: treat it as a fresh connect.
  if (socket.connected) onConnect();

  return () => {
    setSocketConnected(false);
    socket.off('connect', onConnect);
    socket.off('disconnect', onDisconnect);
    socket.off('message:created', onMessageCreated);
    socket.off('message:updated', onMessageUpdated);
    socket.off('message:deleted', onMessageDeleted);
    socket.off('channel:created', onChannelUpsert);
    socket.off('channel:updated', onChannelUpsert);
    socket.off('channel:deleted', onChannelDeleted);
    socket.off('channels:reordered', onChannelsReordered);
    socket.off('dm:created', onDmCreated);
    socket.off('user:updated', onUserUpdated);
    window.removeEventListener('online', onOnline);
  };
}
