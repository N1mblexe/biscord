import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { Server, type Socket } from 'socket.io';
import { z } from 'zod';
import {
  ackErr,
  ackOk,
  clientEventSchemas,
  LIMITS,
  serverEventSchemas,
  SOCKET_PATH,
  type Ack,
  type ClientEventName,
  type ClientToServerEvents,
  type ConnectErrorData,
  type InterServerEvents,
  type ServerEventName,
  type ServerToClientEvents,
  type SessionRevokedReason,
  type SocketData,
} from '@hearth/shared';
import type { Db } from '../db/client.js';
import type { Env } from '../env.js';
import { AppError, loggableError } from '../lib/errors.js';
import { sessionTokenFromCookieHeader } from '../plugins/auth.js';
import { resolveSession, sessionStatus } from '../services/sessions.js';
import { createPresence } from './presence.js';

export type HearthServer = Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;
export type HearthSocket = Socket<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;

export const ROOM_ALL = 'all';
export const userRoom = (userId: string): string => `user:${userId}`;
export const sessionRoom = (sessionId: string): string => `session:${sessionId}`;

declare module 'fastify' {
  interface FastifyInstance {
    realtime: Realtime;
  }
}

export interface Realtime {
  readonly io: HearthServer;
  /** Emit to room `all`. Call only after the DB transaction has committed. */
  emitToAll<E extends ServerEventName>(event: E, ...args: Parameters<ServerToClientEvents[E]>): void;
  /** Emit to room `all` except every socket of `exceptUserId` (room `user:<id>`). */
  emitToAllExcept<E extends ServerEventName>(
    exceptUserId: string,
    event: E,
    ...args: Parameters<ServerToClientEvents[E]>
  ): void;
  /** Emit to room `user:<id>` (every socket of that user). */
  emitToUser<E extends ServerEventName>(
    userId: string,
    event: E,
    ...args: Parameters<ServerToClientEvents[E]>
  ): void;
  /** Emit once to the rooms `user:<id>` of every listed user (a socket in several rooms gets it once). */
  emitToUsers<E extends ServerEventName>(
    userIds: readonly string[],
    event: E,
    ...args: Parameters<ServerToClientEvents[E]>
  ): void;
  /** Emits `session:revoked` to each `session:<id>` room, then closes those sockets. */
  revokeSessions(sessionIds: readonly string[], reason: SessionRevokedReason): void;
  /**
   * B.7 deactivate step 2: emits `session:revoked` once to every socket of the user (room `user:<id>`, plus
   * the rooms of the listed sessions), then closes them all.
   */
  revokeUser(userId: string, sessionIds: readonly string[], reason: SessionRevokedReason): void;
  /** B.7 deactivate step 4: `presence {online:false}` now, without the grace period (only if online). */
  forceOffline(userId: string): void;
  /** Closes every socket (test reset). */
  disconnectAll(): void;
  /** Users with a connected socket, or within the offline grace period (B.5a rule 6), sorted. */
  onlineUserIds(): string[];
  /** Forgets all presence state and pending offline timers without emitting (test reset). */
  resetPresence(): void;
}

export interface RealtimeDeps {
  db: Db;
  env: Env;
  /** Offline grace period (B.5a rule 6). Defaults to `LIMITS.presenceOfflineGraceMs`; tests shorten it. */
  presenceOfflineGraceMs?: number;
  /**
   * Test-only: runs after the handshake resolved the session and before the socket joins its rooms, so a
   * test can revoke the session inside that window.
   */
  afterHandshakeResolved?: (data: SocketData) => Promise<void>;
}

const HANDSHAKE_MESSAGE: Partial<Record<ConnectErrorData['code'], string>> = {
  FORBIDDEN: 'Origin not allowed',
  UNAUTHENTICATED: 'Authentication required',
};

/** Becomes the client's `connect_error`; Socket.IO sends `message` and `data` to the client. */
class HandshakeError extends Error {
  readonly data: ConnectErrorData;

  constructor(data: ConnectErrorData) {
    super(HANDSHAKE_MESSAGE[data.code] ?? 'Internal server error');
    this.data = data;
  }
}

/**
 * Attaches a typed Socket.IO server to `app.server` (same origin, no CORS), authenticates the handshake
 * (Origin ∈ APP_ORIGIN, then the session cookie) and joins `all`, `user:<id>` and `session:<id>`.
 * Decorates `app.realtime` and closes every socket before the HTTP server closes.
 */
export function createRealtime(
  app: FastifyInstance,
  { db, env, presenceOfflineGraceMs = LIMITS.presenceOfflineGraceMs, afterHandshakeResolved }: RealtimeDeps,
): Realtime {
  const io: HearthServer = new Server(app.server, { path: SOCKET_PATH, serveClient: false });
  const assertPayloads = env.NODE_ENV !== 'production';

  io.use((socket, next) => {
    const origin = socket.handshake.headers.origin;
    if (origin === undefined || !env.APP_ORIGIN.includes(origin)) {
      next(new HandshakeError({ code: 'FORBIDDEN' }));
      return;
    }
    const token = sessionTokenFromCookieHeader(socket.handshake.headers.cookie);
    if (token === null) {
      next(new HandshakeError({ code: 'UNAUTHENTICATED' }));
      return;
    }
    resolveSession(db, token, env.SESSION_TTL_DAYS).then(
      (auth) => {
        if (auth === null) {
          next(new HandshakeError({ code: 'UNAUTHENTICATED' }));
          return;
        }
        socket.data.userId = auth.user.id;
        socket.data.sessionId = auth.session.id;
        if (afterHandshakeResolved === undefined) {
          next();
          return;
        }
        afterHandshakeResolved(socket.data).then(
          () => {
            next();
          },
          (err: unknown) => {
            app.log.error({ err: loggableError(err) }, 'socket handshake test hook failed');
            next(new HandshakeError({ code: 'INTERNAL' }));
          },
        );
      },
      (err: unknown) => {
        app.log.error({ err: loggableError(err) }, 'socket handshake failed');
        next(new HandshakeError({ code: 'INTERNAL' }));
      },
    );
  });

  const check = (event: ServerEventName, payload: unknown): void => {
    if (assertPayloads) serverEventSchemas[event].parse(payload);
  };

  const presence = createPresence({
    graceMs: presenceOfflineGraceMs,
    emit: (payload) => {
      check('presence', payload);
      io.to(ROOM_ALL).emit('presence', payload);
    },
  });

  /**
   * A logout, password change or deactivation that committed after the handshake resolved the session but
   * before the socket joined its rooms emitted `session:revoked` to rooms this socket wasn't in yet. Now that
   * it has joined, any later revoke reaches it; this re-read catches the earlier ones.
   */
  const recheckSession = async (socket: HearthSocket): Promise<void> => {
    const { userId, sessionId } = socket.data;
    const status = await sessionStatus(db, userId, sessionId);
    if (status === 'live' || socket.disconnected) return;
    const payload = { reason: status === 'deactivated' ? 'deactivated' : 'logout' } as const;
    check('session:revoked', payload);
    socket.emit('session:revoked', payload);
    socket.disconnect(true);
    // A deactivated user has no other socket: no grace period (B.7 deactivate step 4).
    if (status === 'deactivated') presence.forceOffline(userId);
  };

  io.on('connection', (socket) => {
    const { userId, sessionId } = socket.data;
    // The in-memory adapter joins synchronously, so the new socket also hears its own `online`.
    void socket.join([ROOM_ALL, userRoom(userId), sessionRoom(sessionId)]);
    presence.connect(userId, socket.id);
    socket.on('disconnect', () => {
      presence.disconnect(userId, socket.id);
    });
    recheckSession(socket).catch((err: unknown) => {
      app.log.error({ err: loggableError(err) }, 'socket session re-check failed; disconnecting');
      socket.disconnect(true);
    });
  });

  const realtime: Realtime = {
    io,
    emitToAll(event, ...args) {
      check(event, args[0]);
      io.to(ROOM_ALL).emit(event, ...args);
    },
    emitToAllExcept(exceptUserId, event, ...args) {
      check(event, args[0]);
      io.to(ROOM_ALL)
        .except(userRoom(exceptUserId))
        .emit(event, ...args);
    },
    emitToUser(userId, event, ...args) {
      check(event, args[0]);
      io.to(userRoom(userId)).emit(event, ...args);
    },
    emitToUsers(userIds, event, ...args) {
      check(event, args[0]);
      if (userIds.length === 0) return;
      io.to(userIds.map(userRoom)).emit(event, ...args);
    },
    revokeSessions(sessionIds, reason) {
      if (sessionIds.length === 0) return;
      const rooms = sessionIds.map(sessionRoom);
      io.to(rooms).emit('session:revoked', { reason });
      // `true` closes the underlying connection; packets already queued (the event above) are flushed first.
      io.in(rooms).disconnectSockets(true);
    },
    revokeUser(userId, sessionIds, reason) {
      const rooms = [userRoom(userId), ...sessionIds.map(sessionRoom)];
      io.to(rooms).emit('session:revoked', { reason });
      io.in(rooms).disconnectSockets(true);
    },
    disconnectAll() {
      io.disconnectSockets(true);
    },
    forceOffline: (userId) => {
      presence.forceOffline(userId);
    },
    onlineUserIds: () => presence.onlineUserIds(),
    resetPresence: () => {
      presence.clear();
    },
  };

  app.decorate('realtime', realtime);
  // Close sockets before Fastify closes the HTTP server, which would otherwise wait on upgraded connections.
  // `io.close()` is not used: it also closes the HTTP server, which Fastify owns. The engine closes itself
  // on the server's `close` event.
  app.addHook('preClose', (done) => {
    io.disconnectSockets(true);
    // Those disconnects started grace timers; nobody is left to hear the offline events.
    presence.clear();
    done();
  });
  app.addHook('onClose', (_instance, done) => {
    presence.clear();
    done();
  });

  return realtime;
}

type AckData<E extends ClientEventName> = Parameters<ClientToServerEvents[E]>[1] extends (
  res: Ack<infer T>,
) => void
  ? T
  : never;

export type ClientEventPayload<E extends ClientEventName> = z.output<(typeof clientEventSchemas)[E]>;

export type ClientEventHandler<E extends ClientEventName> = (
  payload: ClientEventPayload<E>,
  socket: HearthSocket,
) => AckData<E> | Promise<AckData<E>>;

function toAckError(err: unknown, log: FastifyBaseLogger | undefined): Ack<never> {
  if (err instanceof AppError) return ackErr(err.code, err.message, err.details);
  log?.error({ err: loggableError(err) }, 'socket event handler failed');
  return ackErr('INTERNAL', 'Internal server error');
}

/**
 * Registers a client→server event handler. The payload is validated with `clientEventSchemas[name]`
 * (VALIDATION ack on failure) and the result, or an `AppError`, is returned through the `Ack<T>` callback.
 * A missing ack callback is tolerated: the handler still runs and nothing is sent back.
 */
export function onClientEvent<E extends ClientEventName>(
  socket: HearthSocket,
  name: E,
  handler: ClientEventHandler<E>,
  log?: FastifyBaseLogger,
): void {
  const schema: z.ZodType = clientEventSchemas[name];

  const run = async (payload: unknown): Promise<Ack<AckData<E>>> => {
    const parsed = schema.safeParse(payload);
    if (!parsed.success) return ackErr('VALIDATION', 'Invalid payload', z.flattenError(parsed.error));
    try {
      // TS cannot correlate `clientEventSchemas[name]` with `E`; the data was parsed by exactly that schema.
      return ackOk(await handler(parsed.data as ClientEventPayload<E>, socket));
    } catch (err) {
      return toAckError(err, log);
    }
  };

  const listener = (payload: unknown, ack: unknown): void => {
    void run(payload).then((result) => {
      if (typeof ack === 'function') (ack as (res: Ack<AckData<E>>) => void)(result);
    });
  };
  // Socket.IO cannot narrow its listener type through the generic `E`; the listener accepts `unknown`
  // for both arguments, so it is safe for whatever a client actually sends.
  socket.on(name, listener as Parameters<typeof socket.on<E>>[1]);
}
