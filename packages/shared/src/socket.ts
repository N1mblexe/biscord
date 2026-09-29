import { z } from 'zod';
import { Emoji } from './emoji.js';
import { type Ack, ErrorCode } from './errors.js';
import { MessageId, Uuid } from './ids.js';
import { Channel, DmChannel } from './schemas/channels.js';
import { Message, ReadState } from './schemas/messages.js';
import { PublicUser } from './schemas/users.js';
import { VoiceParticipant } from './schemas/voice.js';

export const SOCKET_PATH = '/socket.io';
export const CSRF_HEADER = 'x-requested-with';
export const CSRF_HEADER_VALUE = 'hearth';
export const SESSION_COOKIE = 'hearth_session';

/** `err.data` of a handshake `connect_error`. */
export const ConnectErrorData = z.object({ code: ErrorCode });
export type ConnectErrorData = z.infer<typeof ConnectErrorData>;

// ---- Client → server ----

/** Client throttles to 1 per 3 s. */
export const TypingStartPayload = z.object({ channelId: Uuid });
export type TypingStartPayload = z.infer<typeof TypingStartPayload>;

/** Stored in memory; broadcast if the user is joined. */
export const VoiceStatePayload = z.object({
  channelId: Uuid,
  selfMute: z.boolean(),
  selfDeaf: z.boolean(),
  camera: z.boolean(),
  screen: z.boolean(),
});
export type VoiceStatePayload = z.infer<typeof VoiceStatePayload>;

export const clientEventSchemas = {
  'typing:start': TypingStartPayload,
  'voice:state': VoiceStatePayload,
} as const;
export type ClientEventName = keyof typeof clientEventSchemas;

// ---- Server → client ----

export const MessageEventPayload = z.object({ message: Message });
export type MessageEventPayload = z.infer<typeof MessageEventPayload>;

export const MessageDeletedPayload = z.object({ channelId: Uuid, messageId: MessageId });
export type MessageDeletedPayload = z.infer<typeof MessageDeletedPayload>;

export const ReactionEventPayload = z.object({
  channelId: Uuid,
  messageId: MessageId,
  emoji: Emoji,
  userId: Uuid,
});
export type ReactionEventPayload = z.infer<typeof ReactionEventPayload>;

/** Client expires the indicator after 5 s. */
export const TypingPayload = z.object({ channelId: Uuid, userId: Uuid });
export type TypingPayload = z.infer<typeof TypingPayload>;

export const ReadStateUpdatedPayload = z.object({ readState: ReadState });
export type ReadStateUpdatedPayload = z.infer<typeof ReadStateUpdatedPayload>;

export const ChannelEventPayload = z.object({ channel: Channel });
export type ChannelEventPayload = z.infer<typeof ChannelEventPayload>;

export const ChannelDeletedPayload = z.object({ channelId: Uuid });
export type ChannelDeletedPayload = z.infer<typeof ChannelDeletedPayload>;

export const ChannelsReorderedPayload = z.object({ channels: z.array(Channel) });
export type ChannelsReorderedPayload = z.infer<typeof ChannelsReorderedPayload>;

export const DmCreatedPayload = z.object({ channel: DmChannel });
export type DmCreatedPayload = z.infer<typeof DmCreatedPayload>;

export const UserUpdatedPayload = z.object({ user: PublicUser });
export type UserUpdatedPayload = z.infer<typeof UserUpdatedPayload>;

/** Offline is emitted after a 3 s grace period. */
export const PresencePayload = z.object({ userId: Uuid, online: z.boolean() });
export type PresencePayload = z.infer<typeof PresencePayload>;

export const VoiceParticipantEventPayload = z.object({ channelId: Uuid, participant: VoiceParticipant });
export type VoiceParticipantEventPayload = z.infer<typeof VoiceParticipantEventPayload>;

export const VoiceLeftPayload = z.object({ channelId: Uuid, userId: Uuid });
export type VoiceLeftPayload = z.infer<typeof VoiceLeftPayload>;

/** Why the server removed you from voice (sent only to `user:<id>`, B.7b). */
export const VoiceKickedReason = z.enum(['admin', 'channel_deleted', 'deactivated']);
export type VoiceKickedReason = z.infer<typeof VoiceKickedReason>;

export const VoiceKickedPayload = z.object({ channelId: Uuid, reason: VoiceKickedReason });
export type VoiceKickedPayload = z.infer<typeof VoiceKickedPayload>;

export const SessionRevokedReason = z.enum(['logout', 'deactivated', 'password_changed', 'password_reset']);
export type SessionRevokedReason = z.infer<typeof SessionRevokedReason>;

/** Sent before the server disconnects the socket. */
export const SessionRevokedPayload = z.object({ reason: SessionRevokedReason });
export type SessionRevokedPayload = z.infer<typeof SessionRevokedPayload>;

export const serverEventSchemas = {
  'message:created': MessageEventPayload,
  'message:updated': MessageEventPayload,
  'message:deleted': MessageDeletedPayload,
  'reaction:added': ReactionEventPayload,
  'reaction:removed': ReactionEventPayload,
  typing: TypingPayload,
  'readstate:updated': ReadStateUpdatedPayload,
  'channel:created': ChannelEventPayload,
  'channel:updated': ChannelEventPayload,
  'channel:deleted': ChannelDeletedPayload,
  'channels:reordered': ChannelsReorderedPayload,
  'dm:created': DmCreatedPayload,
  'user:updated': UserUpdatedPayload,
  presence: PresencePayload,
  'voice:joined': VoiceParticipantEventPayload,
  'voice:updated': VoiceParticipantEventPayload,
  'voice:left': VoiceLeftPayload,
  'voice:kicked': VoiceKickedPayload,
  'session:revoked': SessionRevokedPayload,
} as const;
export type ServerEventName = keyof typeof serverEventSchemas;

// ---- Socket.IO generics ----

export interface ClientToServerEvents {
  'typing:start': (payload: TypingStartPayload, ack: (res: Ack<null>) => void) => void;
  'voice:state': (payload: VoiceStatePayload, ack: (res: Ack<null>) => void) => void;
}

export interface ServerToClientEvents {
  'message:created': (payload: MessageEventPayload) => void;
  'message:updated': (payload: MessageEventPayload) => void;
  'message:deleted': (payload: MessageDeletedPayload) => void;
  'reaction:added': (payload: ReactionEventPayload) => void;
  'reaction:removed': (payload: ReactionEventPayload) => void;
  typing: (payload: TypingPayload) => void;
  'readstate:updated': (payload: ReadStateUpdatedPayload) => void;
  'channel:created': (payload: ChannelEventPayload) => void;
  'channel:updated': (payload: ChannelEventPayload) => void;
  'channel:deleted': (payload: ChannelDeletedPayload) => void;
  'channels:reordered': (payload: ChannelsReorderedPayload) => void;
  'dm:created': (payload: DmCreatedPayload) => void;
  'user:updated': (payload: UserUpdatedPayload) => void;
  presence: (payload: PresencePayload) => void;
  'voice:joined': (payload: VoiceParticipantEventPayload) => void;
  'voice:updated': (payload: VoiceParticipantEventPayload) => void;
  'voice:left': (payload: VoiceLeftPayload) => void;
  'voice:kicked': (payload: VoiceKickedPayload) => void;
  'session:revoked': (payload: SessionRevokedPayload) => void;
}

export type InterServerEvents = Record<string, never>;

export interface SocketData {
  userId: string;
  sessionId: string;
}
