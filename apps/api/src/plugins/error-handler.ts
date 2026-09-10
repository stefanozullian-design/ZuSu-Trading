import { Prisma } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod';
import { EnvironmentMismatchError, IllegalTransitionError } from '@zusu/shared';
import { config } from '../config/env.js';
import { AppError, type ErrorCode } from '../lib/errors.js';
import { BrokerError } from '../modules/broker/types.js';
import { CircuitOpenError } from '../lib/circuit-breaker.js';

interface ErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    details?: unknown;
    correlationId: string;
  };
}

/**
 * Single error boundary.
 *
 * Anything unrecognised becomes a generic 500: an internal message could carry
 * a connection string or a query fragment, and those never reach a client (§53).
 */
export const errorHandlerPlugin = fp(async (app: FastifyInstance) => {
  app.setErrorHandler((error, request, reply) => {
    const correlationId = request.id;
    const fallbackMessage = error instanceof Error ? error.message : String(error);

    if (hasZodFastifySchemaValidationErrors(error)) {
      return reply.status(422).send({
        error: {
          code: 'VALIDATION_FAILED',
          message: 'The request did not match the expected shape.',
          details: error.validation.map((issue) => ({
            path: issue.instancePath,
            message: issue.message,
          })),
          correlationId,
        },
      } satisfies ErrorBody);
    }

    if (error instanceof AppError) {
      request.log.info(
        { code: error.code, status: error.statusCode, path: request.url },
        'request rejected',
      );
      return reply.status(error.statusCode).send({
        error: {
          code: error.code,
          message: error.exposeMessage ? error.message : 'Something went wrong.',
          ...(error.details === undefined ? {} : { details: error.details }),
          correlationId,
        },
      } satisfies ErrorBody);
    }

    if (error instanceof EnvironmentMismatchError) {
      request.log.error({ err: error }, 'environment isolation violation');
      return reply.status(409).send({
        error: { code: 'ENVIRONMENT_MISMATCH', message: error.message, correlationId },
      } satisfies ErrorBody);
    }

    if (error instanceof IllegalTransitionError) {
      return reply.status(409).send({
        error: { code: 'CONFLICT', message: error.message, correlationId },
      } satisfies ErrorBody);
    }

    if (error instanceof BrokerError || error instanceof CircuitOpenError) {
      request.log.warn({ err: error.message }, 'broker call failed');
      return reply.status(503).send({
        error: {
          code: 'BROKER_UNAVAILABLE',
          message: 'The broker connection is unavailable. No order state has been assumed.',
          correlationId,
        },
      } satisfies ErrorBody);
    }

    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2002') {
        return reply.status(409).send({
          error: { code: 'CONFLICT', message: 'That record already exists.', correlationId },
        } satisfies ErrorBody);
      }
      if (error.code === 'P2025') {
        return reply.status(404).send({
          error: { code: 'NOT_FOUND', message: 'Not found.', correlationId },
        } satisfies ErrorBody);
      }
    }

    if ((error as { statusCode?: number }).statusCode === 429) {
      return reply.status(429).send({
        error: {
          code: 'RATE_LIMITED',
          message: 'Too many requests. Slow down and try again.',
          correlationId,
        },
      } satisfies ErrorBody);
    }

    request.log.error({ err: error, path: request.url }, 'unhandled error');
    return reply.status(500).send({
      error: {
        code: 'INTERNAL',
        message: 'Something went wrong. The incident has been logged.',
        ...(config().isProduction ? {} : { details: fallbackMessage }),
        correlationId,
      },
    } satisfies ErrorBody);
  });

  app.setNotFoundHandler((request, reply) => {
    reply.status(404).send({
      error: { code: 'NOT_FOUND', message: 'Route not found', correlationId: request.id },
    } satisfies ErrorBody);
  });
});
