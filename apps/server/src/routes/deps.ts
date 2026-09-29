import type { Db } from '../db/client.js';
import type { Env } from '../env.js';
import type { AuthGuards } from '../plugins/auth.js';
import type { RateLimiter } from '../plugins/rate-limit.js';
import type { Realtime } from '../realtime/io.js';
import type { Typing } from '../realtime/typing.js';
import type { Storage } from '../storage/paths.js';

/** Everything a route module needs; built once in `buildApp`. */
export interface RouteDeps {
  db: Db;
  env: Env;
  guards: AuthGuards;
  rateLimiter: RateLimiter;
  realtime: Realtime;
  typing: Typing;
  /** The upload directory (B.7a); every file access goes through it. */
  storage: Storage;
}
