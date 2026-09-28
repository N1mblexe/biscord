import { describe, expect, expectTypeOf, it } from 'vitest';
import type { z } from 'zod';
import {
  type ClientToServerEvents,
  type ServerToClientEvents,
  SessionRevokedReason,
  clientEventSchemas,
  serverEventSchemas,
} from '../src/index.js';

type ServerFromSchemas = {
  -readonly [K in keyof typeof serverEventSchemas]: (
    payload: z.infer<(typeof serverEventSchemas)[K]>,
  ) => void;
};
type ClientPayloadsFromSchemas = {
  -readonly [K in keyof typeof clientEventSchemas]: z.infer<(typeof clientEventSchemas)[K]>;
};
type ClientPayloadsFromInterface = {
  [K in keyof ClientToServerEvents]: Parameters<ClientToServerEvents[K]>[0];
};

describe('socket event maps', () => {
  it('interfaces match the schema maps', () => {
    expectTypeOf<ServerToClientEvents>().toEqualTypeOf<ServerFromSchemas>();
    expectTypeOf<ClientPayloadsFromInterface>().toEqualTypeOf<ClientPayloadsFromSchemas>();
  });

  it('covers every B.5 server event', () => {
    expect(Object.keys(serverEventSchemas).sort()).toEqual(
      [
        'message:created',
        'message:updated',
        'message:deleted',
        'reaction:added',
        'reaction:removed',
        'typing',
        'readstate:updated',
        'channel:created',
        'channel:updated',
        'channel:deleted',
        'channels:reordered',
        'dm:created',
        'user:updated',
        'presence',
        'voice:joined',
        'voice:updated',
        'voice:left',
        'session:revoked',
      ].sort(),
    );
    expect(Object.keys(clientEventSchemas).sort()).toEqual(['typing:start', 'voice:state']);
    expect(SessionRevokedReason.options).toEqual([
      'logout',
      'deactivated',
      'password_changed',
      'password_reset',
    ]);
  });

  it('validates voice:state payloads', () => {
    const ok = {
      channelId: '3f2c1b9e-8a4d-4c6b-9f1e-2d3c4b5a6f70',
      selfMute: true,
      selfDeaf: false,
      camera: false,
      screen: false,
    };
    expect(clientEventSchemas['voice:state'].safeParse(ok).success).toBe(true);
    expect(clientEventSchemas['voice:state'].safeParse({ ...ok, camera: 'yes' }).success).toBe(false);
  });
});
