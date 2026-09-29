import type { Db } from '../db/client.js';
import type { Env } from '../env.js';
import type { VoiceBackend } from '../livekit/client.js';
import type { LiveKitHealth } from '../livekit/health.js';
import type { AuthGuards } from '../plugins/auth.js';
import type { RateLimiter } from '../plugins/rate-limit.js';
import type { Realtime } from '../realtime/io.js';
import type { Typing } from '../realtime/typing.js';
import type { VoiceEvents, VoiceState } from '../realtime/voice-state.js';
import type { Lifecycle } from '../services/lifecycle.js';
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
  /** In-memory voice membership (B.6a rule 4). */
  voice: VoiceState;
  /** The `voice:state` handler's per-user buckets. */
  voiceEvents: VoiceEvents;
  /** LiveKit RoomService operations (real client, or a fake in tests). */
  voiceBackend: VoiceBackend;
  livekitHealth: LiveKitHealth;
  /** B.7 / B.7b multi-system flows (role change, (de/re)activation, voice disconnect, channel delete). */
  lifecycle: Lifecycle;
}
