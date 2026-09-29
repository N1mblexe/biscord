import {
  SOCKET_PATH,
  type ClientToServerEvents,
  type ServerEventName,
  type ServerToClientEvents,
} from '@hearth/shared';
import type { FastifyInstance } from 'fastify';
import { io as connectClient, type Socket as ClientSocket } from 'socket.io-client';
import { channels, dmChannels, messages } from '../../src/db/schema.js';
import type { ChannelRow, MessageRow } from '../../src/db/types.js';
import { orderPair } from '../../src/services/dms.js';
import { testDb } from './db.js';
import { waitUntil } from './wait.js';

export type Client = ClientSocket<ServerToClientEvents, ClientToServerEvents>;

export const ORIGIN = 'http://localhost:5173';

export async function insertChannel(
  name: string,
  options: { type?: 'text' | 'voice'; position?: number } = {},
): Promise<ChannelRow> {
  const [row] = await testDb()
    .db.insert(channels)
    .values({ type: options.type ?? 'text', name, position: options.position ?? 0 })
    .returning();
  if (row === undefined) throw new Error('insert returned no row');
  return row;
}

/** A DM between `a` and `b` inserted directly. Returns its channel id. */
export async function insertDm(a: string, b: string): Promise<string> {
  const { db } = testDb();
  const [channel] = await db.insert(channels).values({ type: 'dm', name: null }).returning();
  if (channel === undefined) throw new Error('insert returned no row');
  const { lowId, highId } = orderPair(a, b);
  await db.insert(dmChannels).values({ channelId: channel.id, userLowId: lowId, userHighId: highId });
  return channel.id;
}

export async function insertMessage(
  channelId: string,
  authorId: string,
  content = 'hello',
): Promise<MessageRow> {
  const [row] = await testDb().db.insert(messages).values({ channelId, authorId, content }).returning();
  if (row === undefined) throw new Error('insert returned no row');
  return row;
}

/** Starts listening on an ephemeral port and returns the base URL. */
export async function listen(app: FastifyInstance): Promise<string> {
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (address === null || typeof address === 'string') throw new Error('unexpected server address');
  return `http://127.0.0.1:${address.port}`;
}

export interface RecordedEvent {
  event: string;
  payload: unknown;
}

export interface RecordingClient {
  client: Client;
  events: RecordedEvent[];
  /** Events named `event`, payloads only. */
  of(event: ServerEventName): unknown[];
  /** Waits until at least `n` events named `event` arrived. */
  waitFor(event: ServerEventName, n?: number): Promise<void>;
}

/**
 * Connects a socket with `cookie` and records every server→client event, in arrival order, except the
 * `ignore`d ones (e.g. `presence` in tests about other events).
 */
export async function connectRecording(
  baseUrl: string,
  cookie: string,
  { ignore = [] }: { ignore?: readonly ServerEventName[] } = {},
): Promise<RecordingClient> {
  const client: Client = connectClient(baseUrl, {
    path: SOCKET_PATH,
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
    extraHeaders: { origin: ORIGIN, cookie },
  });
  const events: RecordedEvent[] = [];
  const ignored = new Set<string>(ignore);
  client.onAny((event: string, payload: unknown) => {
    if (!ignored.has(event)) events.push({ event, payload });
  });
  await new Promise<void>((resolve, reject) => {
    client.once('connect', () => {
      resolve();
    });
    client.once('connect_error', reject);
  });
  const of = (event: ServerEventName): unknown[] =>
    events.filter((e) => e.event === event).map((e) => e.payload);
  return {
    client,
    events,
    of,
    waitFor: (event, n = 1) => waitUntil(() => of(event).length >= n, { message: `${event} ×${n}` }),
  };
}

/** True if any recorded payload mentions `channelId` (as `channelId`, `message.channelId` or `channel.id`). */
export function mentionsChannel(events: readonly RecordedEvent[], channelId: string): boolean {
  return events.some(({ payload }) => JSON.stringify(payload).includes(channelId));
}
