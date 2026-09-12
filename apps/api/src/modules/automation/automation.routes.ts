import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { ExecutionMode, Permission } from '@zusu/shared';
import type { AppContainer } from '../../container.js';
import { principalOf } from '../../plugins/auth.js';
import { confirmationPhraseFor } from './automation.service.js';

const executionMode = z.enum([
  ExecutionMode.OBSERVE,
  ExecutionMode.MANUAL_APPROVAL,
  ExecutionMode.LIMITED_AUTO,
  ExecutionMode.FULL_AUTO,
]);

const checkSchema = z.object({
  key: z.string(),
  label: z.string(),
  state: z.enum(['PASS', 'FAIL', 'UNVERIFIABLE']),
  detail: z.string(),
});

const readinessSchema = z.object({
  configId: z.string(),
  portfolioId: z.string(),
  strategyId: z.string(),
  strategyVersionId: z.string(),
  environment: z.string(),
  currentMode: executionMode,
  checks: z.array(checkSchema),
  ready: z.boolean(),
  nextMode: executionMode.nullable(),
  summary: z.string(),
});

/**
 * The automation ladder.
 *
 * There is no route here that raises a mode without a person: `promote` runs
 * behind a session, a permission, portfolio trading rights and a typed
 * confirmation. There is also, deliberately, no route that enables automation
 * across several configurations at once — a control that turns on four
 * strategies with one click is a control nobody reads carefully.
 */
export async function registerAutomationRoutes(
  app: FastifyInstance,
  container: AppContainer,
): Promise<void> {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.get(
    '/configs',
    {
      preHandler: app.requirePermission(Permission.STRATEGY_READ),
      schema: {
        tags: ['automation'],
        summary: 'Every strategy/portfolio pairing you may see, with its automation rung',
        response: {
          200: z.array(
            z.object({
              configId: z.string(),
              strategyName: z.string(),
              version: z.number(),
              portfolioId: z.string(),
              portfolioName: z.string(),
              environment: z.string(),
              isEnabled: z.boolean(),
              mode: executionMode,
              promotedById: z.string().nullable(),
            }),
          ),
        },
      },
    },
    async (request, reply) => reply.send(await container.automation.list(principalOf(request))),
  );

  typed.get(
    '/configs/:id/readiness',
    {
      preHandler: app.requirePermission(Permission.STRATEGY_READ),
      schema: {
        tags: ['automation'],
        summary: 'The eight conditions for going live, each checked independently',
        description:
          'A check that cannot be run reports UNVERIFIABLE and blocks, because "we could not ' +
          'check" is not "it is fine". Every answer carries what it measured and against what.',
        params: z.object({ id: z.string().uuid() }),
        response: { 200: readinessSchema },
      },
    },
    async (request, reply) =>
      reply.send(await container.automation.readinessFor(principalOf(request), request.params.id)),
  );

  typed.post(
    '/configs/:id/mode',
    {
      preHandler: app.requirePermission(Permission.STRATEGY_PROMOTE),
      schema: {
        tags: ['automation'],
        summary: 'Move one configuration along the automation ladder',
        description:
          'Raising needs one rung, an all-pass readiness report and the exact confirmation ' +
          'phrase for the target rung. Lowering needs none of those and is never refused.',
        params: z.object({ id: z.string().uuid() }),
        body: z.object({
          mode: executionMode,
          /** Required when raising; the phrase names the rung being authorised. */
          confirmation: z.string().optional(),
          reason: z.string().max(500).optional(),
        }),
        response: {
          200: z.object({
            configId: z.string(),
            from: executionMode,
            to: executionMode,
            detail: z.string(),
          }),
        },
      },
    },
    async (request, reply) => {
      const change = await container.automation.promote(
        principalOf(request),
        request.params.id,
        request.body.mode,
        {
          ...(request.body.confirmation !== undefined && {
            confirmation: request.body.confirmation,
          }),
          ...(request.body.reason !== undefined && { reason: request.body.reason }),
        },
      );
      return reply.send(change);
    },
  );

  typed.get(
    '/confirmation-phrase/:mode',
    {
      preHandler: app.requireAuth,
      schema: {
        tags: ['automation'],
        summary: 'The exact phrase a promoter must type for a given rung',
        params: z.object({ mode: executionMode }),
        response: { 200: z.object({ mode: executionMode, phrase: z.string() }) },
      },
    },
    async (request, reply) => {
      await reply.send({
        mode: request.params.mode,
        phrase: confirmationPhraseFor(request.params.mode),
      });
    },
  );
}
