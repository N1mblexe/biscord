import { isIP } from 'node:net';
import { z } from 'zod';

const bool = (fallback: boolean) => z.stringbool().default(fallback);
const int = (fallback: number, min: number, max: number) =>
  z.coerce.number().int().min(min).max(max).default(fallback);
/** `1.2.3.4`, `::1`, `10.0.0.0/8` or `fd00::/8` (prefix within the address family's width). */
export function isIpOrCidr(value: string): boolean {
  const slash = value.indexOf('/');
  const address = slash === -1 ? value : value.slice(0, slash);
  const version = isIP(address);
  if (version === 0) return false;
  if (slash === -1) return true;
  const prefix = value.slice(slash + 1);
  return /^\d{1,3}$/.test(prefix) && Number(prefix) <= (version === 4 ? 32 : 128);
}

/**
 * TRUST_PROXY (CONTRACTS B.8): unset / `false` → trust no proxy; otherwise a comma-separated list of proxy
 * IPs/CIDRs whose X-Forwarded-For is honoured. `true` is refused: it would let any client forge its IP.
 */
const trustProxy = z
  .string()
  .optional()
  .transform((raw, ctx): false | string[] => {
    const value = raw?.trim() ?? '';
    if (value === '' || value.toLowerCase() === 'false') return false;
    if (value.toLowerCase() === 'true') {
      ctx.addIssue({
        code: 'custom',
        message:
          '"true" is not allowed (it would trust X-Forwarded-For from any client); use false or a comma-separated list of proxy IPs/CIDRs',
      });
      return z.NEVER;
    }
    const entries = value
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    const badPositions = entries.flatMap((entry, i) => (isIpOrCidr(entry) ? [] : [i + 1]));
    if (entries.length === 0 || badPositions.length > 0) {
      ctx.addIssue({
        code: 'custom',
        message: `Expected false or a comma-separated list of IP addresses/CIDRs (e.g. 172.28.0.10 or 10.0.0.0/8); invalid entry at position ${badPositions.join(', ') || '1'}`,
      });
      return z.NEVER;
    }
    return entries;
  });

/**
 * One APP_ORIGIN entry, normalized to its origin (CONTRACTS B.9 rule 4): `scheme://host[:port]`, lower-case,
 * default port dropped, no trailing slash, so it compares equal to a browser's `Origin` header. An entry with
 * a path, query, fragment or credentials is refused (it names a page, not an origin).
 */
export function normalizeOrigin(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username !== '' || url.password !== '') return null;
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') return null;
  // `new URL('http://x/?')` has an empty search; reject a raw `?`/`#` too.
  if (/[?#]/.test(value)) return null;
  return url.origin;
}

const appOrigins = z.string().transform((raw, ctx): string[] => {
  const entries = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const origins = entries.map(normalizeOrigin);
  const badPositions = origins.flatMap((origin, i) => (origin === null ? [i + 1] : []));
  if (entries.length === 0 || badPositions.length > 0) {
    ctx.addIssue({
      code: 'custom',
      message: `Expected a comma-separated list of origins (scheme://host[:port], no path), e.g. https://hearth.example.com; invalid entry at position ${badPositions.join(', ') || '1'}`,
    });
    return z.NEVER;
  }
  return [...new Set(origins.filter((origin): origin is string => origin !== null))];
});

const postgresUrl = z.string().regex(/^postgres(ql)?:\/\/.+/, 'Expected a postgres:// connection URL');

const EnvSchema = z
  .object({
    // --- App ---
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    PORT: int(3000, 0, 65_535),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    // Proxies (Caddy) whose X-Forwarded-For sets `request.ip`; `false` = use the socket address.
    TRUST_PROXY: trustProxy,
    APP_ORIGIN: appOrigins,

    // --- Postgres ---
    // POSTGRES_* configure the docker-compose container; the server itself only reads the URLs.
    POSTGRES_USER: z.string().optional(),
    POSTGRES_PASSWORD: z.string().optional(),
    POSTGRES_DB: z.string().optional(),
    DATABASE_URL: postgresUrl,
    DATABASE_URL_UNIT: postgresUrl.optional(),
    DATABASE_URL_E2E: postgresUrl.optional(),
    MIGRATE_ON_START: bool(false),

    // --- Accounts ---
    COOKIE_SECURE: bool(false),
    SESSION_TTL_DAYS: int(30, 1, 365),
    MAX_USERS: int(25, 1, 1000),

    // --- Uploads ---
    // A relative path resolves against the repo root, not the working directory (storage/paths.ts).
    UPLOAD_DIR: z.string().min(1).default('./data/uploads'),
    // Upload GC period (unattached > 24 h, temp > 1 h, orphans); 0 disables it. At most one week.
    UPLOAD_GC_INTERVAL_MINUTES: int(60, 0, 10_080),
    // Uploads are refused with STORAGE_FULL when the UPLOAD_DIR filesystem has less free space than this
    // (B.7a rule 8); 0 disables the check. At most 1 TiB.
    UPLOAD_MIN_FREE_MB: int(2048, 0, 1_048_576),

    // --- LiveKit ---
    LIVEKIT_URL: z.url({ protocol: /^https?$/ }),
    LIVEKIT_PUBLIC_URL: z.url({ protocol: /^wss?$/ }),
    LIVEKIT_API_KEY: z.string().min(1),
    LIVEKIT_API_SECRET: z.string().min(32, 'Must be at least 32 characters'),
    // Read by the LiveKit container only.
    LIVEKIT_KEYS: z.string().optional(),

    // --- Voice ---
    // How often the in-memory voice state is reconciled with LiveKit (B.6a rule 4). 1 s .. 1 h.
    VOICE_RECONCILE_MS: int(60_000, 1_000, 3_600_000),

    // --- Test mode ---
    HEARTH_TEST_MODE: bool(false),
    HEARTH_TEST_TOKEN: z.string().min(1).optional(),

    // --- Production ---
    HEARTH_DOMAIN: z.string().min(1).optional(),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production' && env.HEARTH_TEST_MODE) {
      ctx.addIssue({
        code: 'custom',
        path: ['HEARTH_TEST_MODE'],
        message: 'Test mode must never be enabled when NODE_ENV=production',
      });
    }
    if (env.HEARTH_TEST_MODE && env.HEARTH_TEST_TOKEN === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['HEARTH_TEST_TOKEN'],
        message: 'Required when HEARTH_TEST_MODE=true',
      });
    }
  });

export type Env = z.output<typeof EnvSchema>;

export class EnvError extends Error {
  constructor(public readonly issues: readonly string[]) {
    super(`Invalid environment:\n${issues.map((issue) => `  - ${issue}`).join('\n')}`);
    this.name = 'EnvError';
  }
}

/**
 * Parses and validates the environment. Empty strings count as unset.
 * The error message lists offending keys and rules only, never the values.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const cleaned: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && value !== '') cleaned[key] = value;
  }

  const result = EnvSchema.safeParse(cleaned);
  if (!result.success) {
    throw new EnvError(
      result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  }
  return result.data;
}
