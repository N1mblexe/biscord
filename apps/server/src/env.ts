import { z } from 'zod';

const bool = (fallback: boolean) => z.stringbool().default(fallback);
const int = (fallback: number, min: number, max: number) =>
  z.coerce.number().int().min(min).max(max).default(fallback);
const postgresUrl = z.string().regex(/^postgres(ql)?:\/\/.+/, 'Expected a postgres:// connection URL');

const EnvSchema = z
  .object({
    // --- App ---
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    PORT: int(3000, 0, 65_535),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    APP_ORIGIN: z
      .string()
      .transform((value) =>
        value
          .split(',')
          .map((origin) => origin.trim())
          .filter((origin) => origin.length > 0),
      )
      .pipe(z.array(z.url()).min(1)),

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
    UPLOAD_DIR: z.string().min(1).default('./data/uploads'),

    // --- LiveKit ---
    LIVEKIT_URL: z.url({ protocol: /^https?$/ }),
    LIVEKIT_PUBLIC_URL: z.url({ protocol: /^wss?$/ }),
    LIVEKIT_API_KEY: z.string().min(1),
    LIVEKIT_API_SECRET: z.string().min(32, 'Must be at least 32 characters'),
    // Read by the LiveKit container only.
    LIVEKIT_KEYS: z.string().optional(),

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
