import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { ENVIRONMENTS, Permission, systemHealthSchema } from '@zusu/shared';
import { config } from '../../config/env.js';
import { buildInfo } from '../../lib/build-info.js';
import type { AppContainer } from '../../container.js';

export async function registerSystemRoutes(
  app: FastifyInstance,
  container: AppContainer,
): Promise<void> {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  /** Unauthenticated liveness probe for orchestrators. Reveals nothing. */
  typed.get(
    '/live',
    {
      config: { rateLimit: false },
      schema: {
        tags: ['system'],
        summary: 'Liveness probe',
        response: { 200: z.object({ status: z.literal('ok') }) },
      },
    },
    async (_request, reply) => reply.send({ status: 'ok' as const }),
  );

  typed.get(
    '/ready',
    {
      config: { rateLimit: false },
      schema: {
        tags: ['system'],
        summary: 'Readiness probe — fails when the database is unreachable',
        response: {
          200: z.object({ status: z.enum(['ready', 'degraded']) }),
          503: z.object({ status: z.literal('unavailable') }),
        },
      },
    },
    async (_request, reply) => {
      const health = await container.health.snapshot();
      if (health.overall === 'DOWN') {
        return reply.status(503).send({ status: 'unavailable' as const });
      }
      return reply.send({ status: health.overall === 'HEALTHY' ? 'ready' : 'degraded' });
    },
  );

  typed.get(
    '/health',
    {
      preHandler: app.requirePermission(Permission.SYSTEM_READ),
      schema: {
        tags: ['system'],
        summary: 'Per-service health for the system health panel',
        response: { 200: systemHealthSchema },
      },
    },
    async (_request, reply) => reply.send(await container.health.snapshot()),
  );

  typed.get(
    '/version',
    {
      preHandler: app.requireAuth,
      schema: {
        tags: ['system'],
        summary: 'The commit this server is running',
        description:
          'Read from the checkout at start-up, not from a constant somebody has to remember to ' +
          'bump. Null outside a git checkout, because inventing a version would defeat the only ' +
          'thing this answers.',
        response: {
          200: z.object({
            commit: z.string().nullable(),
            committedAt: z.string().nullable(),
            modified: z.boolean(),
          }),
        },
      },
    },
    async (_request, reply) => reply.send(buildInfo()),
  );

  typed.get(
    '/environment',
    {
      preHandler: app.requireAuth,
      schema: {
        tags: ['system'],
        summary: 'The environment this deployment runs in and what it implies',
        response: {
          200: z.object({
            environment: z.enum(['DEMO', 'PAPER', 'LIVE']),
            label: z.string(),
            indicator: z.string(),
            tone: z.enum(['blue', 'amber', 'red']),
            description: z.string(),
            usesRealMoney: z.boolean(),
            requiresExplicitConfirmation: z.boolean(),
            liveTradingAllowed: z.boolean(),
          }),
        },
      },
    },
    async (_request, reply) => {
      const cfg = config();
      const descriptor = ENVIRONMENTS[cfg.DEFAULT_ENVIRONMENT];
      return reply.send({
        environment: descriptor.id,
        label: descriptor.label,
        indicator: descriptor.indicator,
        tone: descriptor.tone,
        description: descriptor.description,
        usesRealMoney: descriptor.usesRealMoney,
        requiresExplicitConfirmation: descriptor.requiresExplicitConfirmation,
        liveTradingAllowed: cfg.ALLOW_LIVE_TRADING,
      });
    },
  );
}
