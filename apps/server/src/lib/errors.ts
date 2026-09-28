import type { FastifyInstance, FastifyReply } from 'fastify';
import { ERROR_STATUS, type ApiErrorBody, type ApiErrorPayload, type ErrorCode } from '@hearth/shared';

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }

  get statusCode(): number {
    return ERROR_STATUS[this.code];
  }
}

const GENERIC_MESSAGE: Partial<Record<ErrorCode, string>> = {
  VALIDATION: 'Invalid request',
  UNAUTHENTICATED: 'Authentication required',
  FORBIDDEN: 'Forbidden',
  NOT_FOUND: 'Not found',
  CONFLICT: 'Conflict',
  PAYLOAD_TOO_LARGE: 'Payload too large',
  UNSUPPORTED_MEDIA: 'Unsupported media type',
  RATE_LIMITED: 'Too many requests',
  INTERNAL: 'Internal server error',
};

const STATUS_CODE: Partial<Record<number, ErrorCode>> = {
  400: 'VALIDATION',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA',
  429: 'RATE_LIMITED',
};

const FASTIFY_CODE: Partial<Record<string, ErrorCode>> = {
  FST_ERR_CTP_BODY_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  FST_ERR_CTP_INVALID_MEDIA_TYPE: 'UNSUPPORTED_MEDIA',
  FST_ERR_CTP_INVALID_JSON_BODY: 'VALIDATION',
  FST_ERR_CTP_EMPTY_JSON_BODY: 'VALIDATION',
  FST_ERR_CTP_INVALID_CONTENT_LENGTH: 'VALIDATION',
  FST_ERR_VALIDATION: 'VALIDATION',
};

interface ErrorLike {
  code?: unknown;
  statusCode?: unknown;
}

function asErrorLike(error: unknown): ErrorLike {
  return typeof error === 'object' && error !== null ? error : {};
}

function sendError(reply: FastifyReply, code: ErrorCode, message: string, details?: unknown): FastifyReply {
  const payload: ApiErrorPayload = details === undefined ? { code, message } : { code, message, details };
  const body: ApiErrorBody = { error: payload };
  return reply.status(ERROR_STATUS[code]).type('application/json; charset=utf-8').send(body);
}

function retryAfterDetails(reply: FastifyReply): { retryAfterMs: number } | undefined {
  const seconds = Number(reply.getHeader('retry-after'));
  return Number.isFinite(seconds) && seconds >= 0 ? { retryAfterMs: Math.round(seconds * 1000) } : undefined;
}

/** Maps every error to the shared `ApiErrorBody` shape (CONTRACTS B.3). */
export function registerErrorHandlers(app: FastifyInstance): void {
  app.setErrorHandler((error: unknown, request, reply) => {
    if (error instanceof AppError) {
      if (error.statusCode >= 500) request.log.error({ err: error }, 'request failed');
      return sendError(reply, error.code, error.message, error.details);
    }

    const { code: rawCode, statusCode: rawStatus } = asErrorLike(error);
    const fastifyCode = typeof rawCode === 'string' ? FASTIFY_CODE[rawCode] : undefined;
    const status = typeof rawStatus === 'number' ? rawStatus : 500;
    const mapped = fastifyCode ?? (status >= 400 && status < 500 ? STATUS_CODE[status] : undefined);

    if (mapped !== undefined) {
      const details = mapped === 'RATE_LIMITED' ? retryAfterDetails(reply) : undefined;
      return sendError(reply, mapped, GENERIC_MESSAGE[mapped] ?? 'Request failed', details);
    }

    if (status >= 400 && status < 500) {
      // A client error without a dedicated code (405, 406, 408, 414, 422, ...): never report it as a 500.
      return sendError(reply, 'VALIDATION', 'Request could not be processed');
    }

    request.log.error({ err: error }, 'unhandled error');
    return sendError(reply, 'INTERNAL', 'Internal server error');
  });

  app.setNotFoundHandler((_request, reply) => sendError(reply, 'NOT_FOUND', 'Route not found'));
}
