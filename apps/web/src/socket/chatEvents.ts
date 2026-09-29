import {
  ChannelDeletedPayload,
  ChannelEventPayload,
  ChannelsReorderedPayload,
  DmCreatedPayload,
  MessageDeletedPayload,
  MessageEventPayload,
  PresencePayload,
  ReactionEventPayload,
  ReadStateUpdatedPayload,
  TypingPayload,
  UserUpdatedPayload,
  type BootstrapResponse,
  type Message,
} from '@hearth/shared';
import type { QueryClient } from '@tanstack/react-query';
import { matchPath } from 'react-router';
import { meQuery } from '../api/auth';
import { bootstrapQueryKey } from '../api/chat';
import { removeChannel, replaceChannels, upsertChannel, upsertDm, upsertUser } from '../lib/bootstrapPatch';
import { catchUpAll, receiveCreated, receiveUpdated, setSocketConnected } from '../lib/messageSync';
import { maybeNotify } from '../lib/notifications';
import { useMessageStore } from '../stores/messages';
import { NOTICES, useNoticeStore } from '../stores/notice';
import { usePresenceStore } from '../stores/presence';
import { useReadsStore } from '../stores/reads';
import { useTypingStore } from '../stores/typing';
import { useVoiceStore } from '../stores/voice';
import { isReadingChannel } from '../stores/viewing';
import type { HearthSocket } from './socket';

export interface ChatEventDeps {
  queryClient: QueryClient;
  /** Router navigation (to `/` when the open channel is deleted, or from a notification). */
  navigate: (to: string) => void;
}

/** The channel id of the page currently shown, if it is `/channels/:channelId`. */
function currentChannelId(): string | null {
  return matchPath('/channels/:channelId', window.location.pathname)?.params.channelId ?? null;
}

/**
 * Chat realtime wiring (CONTRACTS B.5, B.5a):
 * - `message:*` → the message store, only for channels that have a store entry (opened this
 *   session). `message:updated` only replaces messages that are loaded.
 * - `message:created` also clears the author's typing indicator and, for a message from someone
 *   else, updates the unread guess (unless we are reading that channel) and may notify.
 * - `reaction:*` → the loaded message; `typing`, `presence`, `readstate:updated` → their stores.
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

  const bootstrap = () => queryClient.getQueryData<BootstrapResponse>(bootstrapQueryKey);
  const meId = () => bootstrap()?.me.id ?? queryClient.getQueryData(meQuery.queryKey)?.id;

  const onUnreadCandidate = (message: Message) => {
    const boot = bootstrap();
    if (!boot || message.authorId === boot.me.id) return;
    if (!isReadingChannel(message.channelId)) useReadsStore.getState().receiveMessage(message, boot.me.id);
    maybeNotify(message, boot, navigate);
  };

  const onMessageCreated = (payload: unknown) => {
    const parsed = MessageEventPayload.safeParse(payload);
    if (!parsed.success) return;
    const { message } = parsed.data;
    receiveCreated(message);
    useTypingStore.getState().stop(message.channelId, message.authorId);
    onUnreadCandidate(message);
  };
  const onMessageUpdated = (payload: unknown) => {
    const parsed = MessageEventPayload.safeParse(payload);
    if (parsed.success) receiveUpdated(parsed.data.message);
  };
  const onMessageDeleted = (payload: unknown) => {
    const parsed = MessageDeletedPayload.safeParse(payload);
    if (!parsed.success) return;
    messages().remove(parsed.data.channelId, parsed.data.messageId);
    useReadsStore.getState().removeMessage(parsed.data.channelId, parsed.data.messageId);
  };
  const onReaction = (added: boolean) => (payload: unknown) => {
    const parsed = ReactionEventPayload.safeParse(payload);
    if (!parsed.success) return;
    const { channelId, messageId, emoji, userId } = parsed.data;
    messages().applyReaction(channelId, messageId, emoji, userId, added);
  };
  const onReactionAdded = onReaction(true);
  const onReactionRemoved = onReaction(false);
  const onTyping = (payload: unknown) => {
    const parsed = TypingPayload.safeParse(payload);
    if (!parsed.success || parsed.data.userId === meId()) return;
    useTypingStore.getState().start(parsed.data.channelId, parsed.data.userId);
  };
  const onPresence = (payload: unknown) => {
    const parsed = PresencePayload.safeParse(payload);
    if (!parsed.success) return;
    usePresenceStore.getState().setOnline(parsed.data.userId, parsed.data.online);
  };
  const onReadStateUpdated = (payload: unknown) => {
    const parsed = ReadStateUpdatedPayload.safeParse(payload);
    if (!parsed.success) return;
    useReadsStore.getState().applyServer(parsed.data.readState);
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
    useReadsStore.getState().forgetChannel(channelId);
    useTypingStore.getState().clearChannel(channelId);
    useVoiceStore.getState().forgetChannel(channelId);
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
  socket.on('reaction:added', onReactionAdded);
  socket.on('reaction:removed', onReactionRemoved);
  socket.on('typing', onTyping);
  socket.on('presence', onPresence);
  socket.on('readstate:updated', onReadStateUpdated);
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
    socket.off('reaction:added', onReactionAdded);
    socket.off('reaction:removed', onReactionRemoved);
    socket.off('typing', onTyping);
    socket.off('presence', onPresence);
    socket.off('readstate:updated', onReadStateUpdated);
    socket.off('channel:created', onChannelUpsert);
    socket.off('channel:updated', onChannelUpsert);
    socket.off('channel:deleted', onChannelDeleted);
    socket.off('channels:reordered', onChannelsReordered);
    socket.off('dm:created', onDmCreated);
    socket.off('user:updated', onUserUpdated);
    window.removeEventListener('online', onOnline);
  };
}
