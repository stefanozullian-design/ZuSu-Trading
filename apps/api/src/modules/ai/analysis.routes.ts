import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { Permission } from '@zusu/shared';
import type { AppContainer } from '../../container.js';
import { principalOf } from '../../plugins/auth.js';
import { TIMEFRAMES } from '../market-data/types.js';

/**
 * Analysis (§50–§56).
 *
 * Note what these routes cannot do. There is no endpoint that acts on an
 * analysis, no field in any response that an order could be built from, and no
 * way for a model's output to reach a broker. An analysis is advice attached to
 * a signal; the approval route is still the only path to an order, and it still
 * needs a person.
 *
 * Every response carries the spend so far today. A model that quietly costs
 * money is the failure mode this module was built to prevent, so the number is
 * in front of the person who triggered the call rather than in a log.
 */

const analysisSchema = z.object({
  id: z.string().uuid(),
  signalId: z.string().uuid().nullable(),
  portfolioId: z.string().uuid().nullable(),
  model: z.string(),
  purpose: z.string(),
  responseValid: z.boolean(),
  validationError: z.string().nullable(),
  action: z.string().nullable(),
  confidence: z.string().nullable(),
  riskLevel: z.string().nullable(),
  regime: z.string().nullable(),
  rationale: z.string().nullable(),
  invalidation: z.string().nullable(),
  missingContext: z.array(z.string()),
  inputTokens: z.number().int().nullable(),
  outputTokens: z.number().int().nullable(),
  costUsd: z.string().nullable(),
  latencyMs: z.number().int().nullable(),
  createdAt: z.string().datetime(),
});

const spendSchema = z.object({
  spentTodayUsd: z.string(),
  callsLastHour: z.number().int(),
  limits: z.object({
    dailyUsd: z.string(),
    callsPerHour: z.number().int(),
    maxOutputTokensPerCall: z.number().int(),
  }),
  providerConfigured: z.boolean(),
  providerName: z.string(),
});

export async function registerAnalysisRoutes(
  app: FastifyInstance,
  container: AppContainer,
): Promise<void> {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const read = { preHandler: app.requirePermission(Permission.SIGNAL_READ) };
  // Spending money is a write, even though nothing is traded: the person who
  // can run a model is the person whose budget it is.
  const run = { preHandler: app.requirePermission(Permission.STRATEGY_WRITE) };

  typed.get(
    '/spend',
    {
      ...read,
      schema: {
        tags: ['analysis'],
        summary: 'What has been spent on analysis today, and the caps',
        response: { 200: spendSchema },
      },
    },
    async (_request, reply) => {
      return reply.send(await container.analysis.spend());
    },
  );

  typed.get(
    '/',
    {
      ...read,
      schema: {
        tags: ['analysis'],
        summary: 'Recent analyses, including the ones that failed',
        description:
          'A refused or unparseable run is a row like any other. "The analysis ' +
          'did not happen" has to be as visible as one that did.',
        querystring: z.object({
          portfolioId: z.string().uuid().optional(),
          signalId: z.string().uuid().optional(),
          limit: z.coerce.number().int().min(1).max(100).default(25),
        }),
        response: {
          200: z.object({ analyses: z.array(analysisSchema), spend: spendSchema }),
        },
      },
    },
    async (request, reply) => {
      const [analyses, spend] = await Promise.all([
        container.analysis.list({
          ...(request.query.portfolioId ? { portfolioId: request.query.portfolioId } : {}),
          ...(request.query.signalId ? { signalId: request.query.signalId } : {}),
          limit: request.query.limit,
        }),
        container.analysis.spend(),
      ]);
      return reply.send({ analyses: analyses.map(serialise), spend });
    },
  );

  typed.post(
    '/screen',
    {
      ...run,
      schema: {
        tags: ['analysis'],
        summary: 'Stage one: screen symbols down to a shortlist',
        description:
          'A cheap model, and an output schema with no field for advice. The ' +
          'screen decides where to look, never what to do. Symbols it sets ' +
          'aside come back with their reason.',
        body: z.object({
          symbols: z.array(z.string().min(1).max(12)).min(1).max(50),
          timeframe: z.enum(TIMEFRAMES).default('5m'),
          portfolioId: z.string().uuid().nullable().optional(),
        }),
        response: {
          200: z.object({
            analysisId: z.string().uuid(),
            refusal: z.string().nullable(),
            shortlist: z.array(z.object({ symbol: z.string(), reason: z.string() })),
            setAside: z.array(z.object({ symbol: z.string(), reason: z.string() })),
            spend: spendSchema,
          }),
        },
      },
    },
    async (request, reply) => {
      const body = request.body;
      if (body.portfolioId) {
        await container.access.assertPortfolioAccess(principalOf(request), body.portfolioId, {
          permission: Permission.STRATEGY_WRITE,
        });
      }

      const outcome = await container.analysis.screen({
        symbols: body.symbols.map((symbol) => symbol.toUpperCase()),
        timeframe: body.timeframe,
        ...(body.portfolioId !== undefined && { portfolioId: body.portfolioId }),
      });

      return reply.send({
        analysisId: outcome.analysisId,
        refusal: outcome.refusal,
        shortlist: outcome.result?.shortlist ?? [],
        setAside: outcome.result?.setAside ?? [],
        spend: await container.analysis.spend(),
      });
    },
  );

  typed.post(
    '/signals/:id',
    {
      ...run,
      schema: {
        tags: ['analysis'],
        summary: 'Stage two: analyse one signal',
        description:
          'Stores advice against the signal and changes nothing about it. An ' +
          'analysis saying CONSIDER at high confidence has exactly as much ' +
          'authority as one saying AVOID: none. A person still approves.',
        params: z.object({ id: z.string().uuid() }),
        response: {
          200: z.object({
            analysisId: z.string().uuid(),
            refusal: z.string().nullable(),
            analysis: analysisSchema.nullable(),
            spend: spendSchema,
          }),
        },
      },
    },
    async (request, reply) => {
      const signal = await container.db.signal.findUnique({
        where: { id: request.params.id },
        select: { portfolioId: true },
      });
      if (signal) {
        await container.access.assertPortfolioAccess(principalOf(request), signal.portfolioId, {
          permission: Permission.STRATEGY_WRITE,
        });
      }

      const outcome = await container.analysis.analyseSignal({ signalId: request.params.id });
      const [stored] = await container.analysis.list({ limit: 1, signalId: request.params.id });

      return reply.send({
        analysisId: outcome.analysisId,
        refusal: outcome.refusal,
        analysis: stored ? serialise(stored) : null,
        spend: await container.analysis.spend(),
      });
    },
  );
}

type Analysis = Awaited<ReturnType<AppContainer['analysis']['list']>>[number];

function serialise(analysis: Analysis) {
  return { ...analysis, createdAt: analysis.createdAt.toISOString() };
}
