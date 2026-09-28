import type { FastifyReply } from 'fastify';
import type { z } from 'zod';

/**
 * Sends `data` as the response body. Outside production the body is checked against the shared response
 * schema first, so a contract drift fails loudly (500) in dev and tests instead of reaching the client.
 */
export function send<S extends z.ZodType>(
  reply: FastifyReply,
  schema: S,
  data: z.input<S>,
  status = 200,
): FastifyReply {
  const body: unknown = process.env.NODE_ENV === 'production' ? data : schema.parse(data);
  return reply.status(status).send(body);
}
