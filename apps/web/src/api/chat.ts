import {
  BootstrapResponse,
  ChannelResponse,
  ChannelsResponse,
  DmChannelResponse,
  LIMITS,
  ListMessagesResponse,
  MessageResponse,
  type Channel,
  type CreateChannelRequest,
  type DmChannel,
  type Message,
} from '@hearth/shared';
import { queryOptions } from '@tanstack/react-query';
import { apiFetch } from './client';

export const bootstrapQueryKey = ['bootstrap'] as const;

/**
 * GET /bootstrap. Kept current by socket events (see socket/chatEvents.ts) and invalidated on every
 * reconnect, so it never goes stale on its own and isn't refetched on window focus.
 */
export const bootstrapQuery = queryOptions({
  queryKey: bootstrapQueryKey,
  queryFn: ({ signal }): Promise<BootstrapResponse> =>
    apiFetch('/bootstrap', { schema: BootstrapResponse, signal }),
  staleTime: Infinity,
  refetchOnWindowFocus: false,
});

export interface MessagePageParams {
  /** At most one of `before` / `after`; neither = the latest page. */
  before?: string;
  after?: string;
  limit?: number;
}

/** GET /channels/:id/messages — always ascending by id. */
export async function fetchMessages(
  channelId: string,
  { before, after, limit = LIMITS.messageHistoryPageDefault }: MessagePageParams = {},
  signal?: AbortSignal,
): Promise<Message[]> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (before !== undefined) params.set('before', before);
  if (after !== undefined) params.set('after', after);
  const res = await apiFetch(`/channels/${encodeURIComponent(channelId)}/messages?${params.toString()}`, {
    schema: ListMessagesResponse,
    signal,
  });
  return res.messages;
}

export async function sendMessage(channelId: string, content: string, nonce: string): Promise<Message> {
  const res = await apiFetch(`/channels/${encodeURIComponent(channelId)}/messages`, {
    method: 'POST',
    body: { content, nonce, attachmentIds: [] },
    schema: MessageResponse,
  });
  return res.message;
}

export async function editMessage(messageId: string, content: string): Promise<Message> {
  const res = await apiFetch(`/messages/${encodeURIComponent(messageId)}`, {
    method: 'PATCH',
    body: { content },
    schema: MessageResponse,
  });
  return res.message;
}

export function deleteMessage(messageId: string): Promise<undefined> {
  return apiFetch(`/messages/${encodeURIComponent(messageId)}`, { method: 'DELETE' });
}

/** POST /dms — get-or-create the DM with `userId`. */
export async function openDm(userId: string): Promise<DmChannel> {
  const res = await apiFetch('/dms', { method: 'POST', body: { userId }, schema: DmChannelResponse });
  return res.channel;
}

// ---- Admin: channels ----

export async function createChannel(body: CreateChannelRequest): Promise<Channel> {
  const res = await apiFetch('/channels', { method: 'POST', body, schema: ChannelResponse });
  return res.channel;
}

export async function renameChannel(channelId: string, name: string): Promise<Channel> {
  const res = await apiFetch(`/channels/${encodeURIComponent(channelId)}`, {
    method: 'PATCH',
    body: { name },
    schema: ChannelResponse,
  });
  return res.channel;
}

/** PUT /channels/order — `ids` must be every non-DM channel, in the new order. */
export async function reorderChannels(ids: string[]): Promise<Channel[]> {
  const res = await apiFetch('/channels/order', { method: 'PUT', body: { ids }, schema: ChannelsResponse });
  return res.channels;
}

export function deleteChannel(channelId: string): Promise<undefined> {
  return apiFetch(`/channels/${encodeURIComponent(channelId)}`, { method: 'DELETE' });
}
