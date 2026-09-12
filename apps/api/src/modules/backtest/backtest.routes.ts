import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { Permission } from '@zusu/shared';
import type { AppContainer } from '../../container.js';
import { principalOf } from '../../plugins/auth.js';
import { riskSettingsSchema, strategyDefinitionSchema } from '../strategies/strategy.service.js';

/**
 * Backtests (§29–§32).
 *
 * A backtest is a claim about the past, and these routes are built so the
 * claim always arrives with its assumptions: the stored `parameters` carry the
 * costs, the universe and the list of modelling rules the engine applied, and
 * every metric is reported net of those costs with the gross figure beside it.
 *
 * `/optimise` returns a ranking and the reasons to doubt it. It writes
 * nothing: a search of the past choosing the rules that trade real money is
 * the decision this platform reserves for a person.
 */

const idParams = z.object({ id: z.string().uuid() });

const costsSchema = z
  .object({
    commissionPerTrade: z.string().optional(),
    commissionPerShare: z.string().optional(),
    spreadFraction: z.string().optional(),
    slippageFraction: z.string().optional(),
  })
  .optional();

const metricsSchema = z.record(z.unknown()).nullable();

const summarySchema = z.object({
  id: z.string().uuid(),
  strategyId: z.string().uuid(),
  strategyVersionId: z.string().uuid(),
  strategyName: z.string(),
  version: z.number().int(),
  status: z.string(),
  timeframe: z.string(),
  startDate: z.string().datetime(),
  endDate: z.string().datetime(),
  initialCapital: z.string(),
  parameters: z.record(z.unknown()),
  metrics: metricsSchema,
  walkForward: z.record(z.unknown()).nullable(),
  monteCarlo: z.record(z.unknown()).nullable(),
  equityCurve: z.array(z.object({ at: z.string(), equity: z.string() })),
  skips: z.array(z.object({ at: z.string(), symbol: z.string(), reason: z.string() })),
  errorMessage: z.string().nullable(),
  createdAt: z.string().datetime(),
  finishedAt: z.string().datetime().nullable(),
  tradeCount: z.number().int(),
});

const tradeSchema = z.object({
  symbol: z.string(),
  direction: z.string(),
  quantity: z.string(),
  entryTime: z.string().datetime(),
  entryPrice: z.string(),
  exitTime: z.string().datetime().nullable(),
  exitPrice: z.string().nullable(),
  grossPnl: z.string().nullable(),
  fees: z.string(),
  slippage: z.string(),
  netPnl: z.string().nullable(),
  rMultiple: z.string().nullable(),
  maeAmount: z.string().nullable(),
  mfeAmount: z.string().nullable(),
  exitReason: z.string().nullable(),
});

export async function registerBacktestRoutes(
  app: FastifyInstance,
  container: AppContainer,
): Promise<void> {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const read = { preHandler: app.requirePermission(Permission.BACKTEST_READ) };
  const write = { preHandler: app.requirePermission(Permission.BACKTEST_WRITE) };

  typed.get(
    '/',
    {
      ...read,
      schema: {
        tags: ['backtests'],
        summary: 'Recent backtests',
        querystring: z.object({
          strategyId: z.string().uuid().optional(),
          limit: z.coerce.number().int().min(1).max(100).default(25),
        }),
        response: { 200: z.object({ backtests: z.array(summarySchema) }) },
      },
    },
    async (request, reply) => {
      const backtests = await container.backtests.list({
        ...(request.query.strategyId ? { strategyId: request.query.strategyId } : {}),
        limit: request.query.limit,
      });
      return reply.send({ backtests: backtests.map(serialiseSummary) });
    },
  );

  typed.get(
    '/:id',
    {
      ...read,
      schema: {
        tags: ['backtests'],
        summary: 'One backtest, with every trade it took',
        params: idParams,
        response: { 200: summarySchema.extend({ trades: z.array(tradeSchema) }) },
      },
    },
    async (request, reply) => {
      const backtest = await container.backtests.get(request.params.id);
      return reply.send({
        ...serialiseSummary(backtest),
        trades: backtest.trades.map((trade) => ({
          ...trade,
          entryTime: trade.entryTime.toISOString(),
          exitTime: trade.exitTime ? trade.exitTime.toISOString() : null,
        })),
      });
    },
  );

  typed.post(
    '/',
    {
      ...write,
      schema: {
        tags: ['backtests'],
        summary: 'Run a backtest over stored history',
        description:
          'Runs against the bars already stored, so a window with no history ' +
          'fails with that reason rather than returning a flat result. Every ' +
          'figure is net of the modelled commission, spread and slippage.',
        body: z.object({
          strategyVersionId: z.string().uuid(),
          from: z.string().datetime(),
          to: z.string().datetime(),
          initialCapital: z.string().optional(),
          costs: costsSchema,
          portfolioId: z.string().uuid().nullable().optional(),
          /** Skips walk-forward and Monte Carlo, which dominate the runtime. */
          quick: z.boolean().default(false),
          monteCarloSeed: z.number().int().optional(),
        }),
        response: { 201: summarySchema },
      },
    },
    async (request, reply) => {
      const body = request.body;
      const summary = await container.backtests.run({
        strategyVersionId: body.strategyVersionId,
        from: new Date(body.from),
        to: new Date(body.to),
        quick: body.quick,
        requestedById: principalOf(request).id,
        ...(body.initialCapital !== undefined && { initialCapital: body.initialCapital }),
        ...(body.costs !== undefined && { costs: body.costs }),
        ...(body.portfolioId !== undefined && { portfolioId: body.portfolioId }),
        ...(body.monteCarloSeed !== undefined && { monteCarloSeed: body.monteCarloSeed }),
      });
      return reply.code(201).send(serialiseSummary(summary));
    },
  );

  typed.post(
    '/optimise',
    {
      ...write,
      schema: {
        tags: ['backtests'],
        summary: 'Rank candidate parameter sets, with the reasons to doubt the ranking',
        description:
          'Stores nothing and changes nothing. The best of many candidates is ' +
          'partly a measure of how many were tried, so the response carries ' +
          'warnings alongside the ranking and a person decides what becomes a ' +
          'version.',
        body: z.object({
          strategyVersionId: z.string().uuid(),
          from: z.string().datetime(),
          to: z.string().datetime(),
          initialCapital: z.string().optional(),
          costs: costsSchema,
          candidates: z
            .array(
              z.object({
                label: z.string().min(1).max(120),
                definition: strategyDefinitionSchema,
                riskSettings: riskSettingsSchema.partial().optional(),
              }),
            )
            .min(1)
            .max(40),
        }),
        response: {
          200: z.object({
            candidates: z.array(
              z.object({
                label: z.string(),
                totalReturnPct: z.string(),
                maxDrawdownPct: z.string(),
                tradeCount: z.number().int(),
                profitFactor: z.string().nullable(),
                score: z.string(),
              }),
            ),
            best: z.record(z.unknown()).nullable(),
            warnings: z.array(z.string()),
          }),
        },
      },
    },
    async (request, reply) => {
      const body = request.body;
      const result = await container.backtests.optimise({
        strategyVersionId: body.strategyVersionId,
        from: new Date(body.from),
        to: new Date(body.to),
        candidates: body.candidates,
        ...(body.initialCapital !== undefined && { initialCapital: body.initialCapital }),
        ...(body.costs !== undefined && { costs: body.costs }),
      });
      return reply.send({
        ...result,
        best: result.best as unknown as Record<string, unknown> | null,
      });
    },
  );
}

type Summary = Awaited<ReturnType<AppContainer['backtests']['list']>>[number];

function serialiseSummary(summary: Summary) {
  return {
    ...summary,
    parameters: summary.parameters as unknown as Record<string, unknown>,
    metrics: summary.metrics as unknown as Record<string, unknown> | null,
    walkForward: summary.walkForward as unknown as Record<string, unknown> | null,
    monteCarlo: summary.monteCarlo as unknown as Record<string, unknown> | null,
    startDate: summary.startDate.toISOString(),
    endDate: summary.endDate.toISOString(),
    createdAt: summary.createdAt.toISOString(),
    finishedAt: summary.finishedAt ? summary.finishedAt.toISOString() : null,
  };
}
