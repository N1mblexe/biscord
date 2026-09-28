import { z } from 'zod';

export const HealthResponse = z.object({
  status: z.enum(['ok', 'degraded']),
  db: z.enum(['ok', 'down']),
  livekit: z.enum(['ok', 'down']).optional(),
});
export type HealthResponse = z.infer<typeof HealthResponse>;
