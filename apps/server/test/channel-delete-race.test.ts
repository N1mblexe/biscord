import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import pg from 'pg';
import { afterAll, afterEach, beforeEach, describe, it } from 'vitest';
import type { ChannelRow, MessageRow } from '../src/db/types.js';
import { makeApp } from './helpers/app.js';
import { api, expectError, insertUser, login } from './helpers/auth.js';
import { insertChannel, insertMessage } from './helpers/chat.js';
import { closeTestDb, testDb, truncateAll } from './helpers/db.js';
import { unitDatabaseUrl } from './helpers/env.js';
import { waitUntil } from './helpers/wait.js';

// CONTRACTS B.9 rule 6: a write racing a channel delete is a 404 NOT_FOUND, never a 500. Deterministic: a
// second connection deletes the channel in an open transaction, the request passes its access check (the
// delete isn't committed) and blocks on the channel row; then the delete commits.

let app: FastifyInstance;
let cookie: string;
let general: ChannelRow;
let message: MessageRow;
let aliceId: string;
let holder: pg.Client | undefined;

beforeEach(async () => {
  await truncateAll();
  app = makeApp();
  await app.ready();
  aliceId = (await insertUser('alice')).id;
  const bob = await insertUser('bob');
  cookie = await login(app, 'alice');
  general = await insertChannel('general');
  message = await insertMessage(general.id, bob.id, 'from bob');
});
afterEach(async () => {
  await holder?.query('rollback').catch(() => undefined);
  await holder?.end();
  holder = undefined;
  await app.close();
});
afterAll(closeTestDb);

/**
 * Starts `request` while another transaction holds an uncommitted delete of #general, waits until the
 * request is blocked on a lock, then commits the delete and returns the response.
 */
async function duringChannelDelete(
  request: () => Promise<LightMyRequestResponse>,
): Promise<LightMyRequestResponse> {
  holder = new pg.Client({ connectionString: unitDatabaseUrl() });
  await holder.connect();
  await holder.query('begin');
  await holder.query('delete from channels where id = $1', [general.id]);
  const holderPid = (await holder.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]?.pid;

  const pending = request();
  const blocked = async (): Promise<boolean> => {
    const { rows } = await testDb().pool.query<{ n: number }>(
      `select count(*)::int as n from pg_stat_activity
       where datname = current_database() and wait_event_type = 'Lock' and $1 = any(pg_blocking_pids(pid))`,
      [holderPid],
    );
    return (rows[0]?.n ?? 0) > 0;
  };
  await waitUntil(blocked, { timeoutMs: 5_000, message: 'the request to block on the channel delete' });
  await holder.query('commit');
  return pending;
}

describe('writes racing a channel delete → 404 NOT_FOUND', () => {
  it('sending a message', async () => {
    const res = await duringChannelDelete(() =>
      api(app, 'POST', `/api/channels/${general.id}/messages`, { cookie, body: { content: 'hi' } }),
    );
    expectError(res, 404, 'NOT_FOUND');
  });

  it('marking the channel read', async () => {
    const res = await duringChannelDelete(() =>
      api(app, 'POST', `/api/channels/${general.id}/read`, {
        cookie,
        body: { messageId: String(message.id) },
      }),
    );
    expectError(res, 404, 'NOT_FOUND');
  });

  it('reacting to one of its messages', async () => {
    const res = await duringChannelDelete(() =>
      api(app, 'PUT', `/api/messages/${message.id}/reactions/${encodeURIComponent('👍')}`, { cookie }),
    );
    expectError(res, 404, 'NOT_FOUND');
  });

  it('editing one of its messages', async () => {
    const own = await insertMessage(general.id, aliceId, 'mine');
    const res = await duringChannelDelete(() =>
      api(app, 'PATCH', `/api/messages/${own.id}`, { cookie, body: { content: 'edited @bob' } }),
    );
    expectError(res, 404, 'NOT_FOUND');
  });
});
