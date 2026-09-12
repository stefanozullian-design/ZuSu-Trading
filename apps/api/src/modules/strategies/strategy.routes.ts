import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { ExecutionMode, Permission, StrategyStage, TradingSessionScope } from '@zusu/shared';
import type { AppContainer } from '../../container.js';
import { principalOf } from '../../plugins/auth.js';
import { riskSettingsSchema, strategyDefinitionSchema } from './strategy.service.js';

/**
 * Strategies, versions and signals (§10, §11).
 *
 * Nothing here can place an order. The most a signal route does is record a
 * recommendation at status CREATED; advancing one toward a broker belongs to
 * the risk engine and the order manager, which do not exist yet — so the
 * boundary is structural rather than a promise.
 *
 * Promotion needs `strategy:promote`, which stops at ADMIN. Authoring needs
 * `strategy:write`, which a MANAGER has. Separating them is the point: the
 * person who writes a rule is not automatically the person who lets it run.
 */

const idParams = z.object({ id: z.string().uuid() });

const versionSchema = z.object({
  id: z.string().uuid(),
  strategyId: z.string().uuid(),
  version: z.number().int(),
  stage: z.string(),
  changeDescription: z.string(),
  /** Null when this build cannot read the version's rule language. */
  definition: z.record(z.unknown()).nullable(),
  riskSettings: z.record(z.unknown()).nullable(),
  executionMode: z.string(),
  sessionScope: z.string(),
  entrySummary: z.string().nullable(),
  exitSummary: z.string().nullable(),
  fieldsUsed: z.array(z.string()),
  frozen: z.boolean(),
  authorId: z.string().uuid().nullable(),
  approvedById: z.string().uuid().nullable(),
  approvedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});

const strategySchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  description: z.string().nullable(),
  isArchived: z.boolean(),
  versions: z.array(versionSchema),
  liveVersion: versionSchema.nullable(),
  latestVersion: versionSchema.nullable(),
});

const evaluationSchema = z.object({
  strategyId: z.string().uuid(),
  strategyVersionId: z.string().uuid(),
  version: z.number().int(),
  timeframe: z.string(),
  correlationId: z.string().uuid(),
  evaluatedAt: z.string().datetime(),
  created: z.array(
    z.object({
      id: z.string().uuid(),
      signalKey: z.string(),
      symbol: z.string(),
      direction: z.string(),
    }),
  ),
  duplicates: z.array(z.string()),
  rejected: z.array(z.string()),
  notEvaluable: z.array(z.object({ symbol: z.string(), reason: z.string() })),
});

const signalSchema = z.object({
  id: z.string().uuid(),
  signalKey: z.string(),
  symbol: z.string(),
  direction: z.string(),
  status: z.string(),
  referencePrice: z.string(),
  suggestedStop: z.string().nullable(),
  suggestedTarget: z.string().nullable(),
  strategyName: z.string().nullable(),
  strategyVersion: z.number().int().nullable(),
  conditionSnapshot: z.record(z.unknown()),
  createdAt: z.string().datetime(),
});

export async function registerStrategyRoutes(
  app: FastifyInstance,
  container: AppContainer,
): Promise<void> {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const read = { preHandler: app.requirePermission(Permission.STRATEGY_READ) };
  const write = { preHandler: app.requirePermission(Permission.STRATEGY_WRITE) };
  const promote = { preHandler: app.requirePermission(Permission.STRATEGY_PROMOTE) };
  const signalRead = { preHandler: app.requirePermission(Permission.SIGNAL_READ) };

  typed.get(
    '/',
    {
      ...read,
      schema: {
        tags: ['strategies'],
        summary: 'Every strategy with its version history',
        response: { 200: z.object({ strategies: z.array(strategySchema) }) },
      },
    },
    async (_request, reply) => {
      const strategies = await container.strategies.list();
      return reply.send({ strategies: strategies.map(serialiseStrategy) });
    },
  );

  typed.get(
    '/:id',
    {
      ...read,
      schema: {
        tags: ['strategies'],
        summary: 'One strategy',
        params: idParams,
        response: { 200: strategySchema },
      },
    },
    async (request, reply) => {
      return reply.send(serialiseStrategy(await container.strategies.get(request.params.id)));
    },
  );

  typed.post(
    '/',
    {
      ...write,
      schema: {
        tags: ['strategies'],
        summary: 'Create a strategy and its first version',
        description:
          'The version starts at DRAFT. A rule is data — a nested record of ' +
          'conditions — never code, so nothing supplied here is ever executed.',
        body: z.object({
          name: z.string().min(1).max(80),
          description: z.string().max(600).nullable().optional(),
          definition: strategyDefinitionSchema,
          riskSettings: riskSettingsSchema,
          changeDescription: z.string().min(8).max(400),
        }),
        response: { 201: strategySchema },
      },
    },
    async (request, reply) => {
      const created = await container.strategies.create({
        ...request.body,
        authorId: principalOf(request).id,
      });
      return reply.code(201).send(serialiseStrategy(created));
    },
  );

  typed.post(
    '/:id/versions',
    {
      ...write,
      schema: {
        tags: ['strategies'],
        summary: 'Add a version — the only way to change a strategy',
        description:
          'A definition is frozen the moment it is written, so a change is ' +
          'always a new version starting back at DRAFT. The lineage is kept, ' +
          'so "what were we running in August" has an answer.',
        params: idParams,
        body: z.object({
          definition: strategyDefinitionSchema,
          riskSettings: riskSettingsSchema,
          changeDescription: z.string().min(8).max(400),
        }),
        response: { 201: versionSchema },
      },
    },
    async (request, reply) => {
      const created = await container.strategies.addVersion(request.params.id, {
        ...request.body,
        authorId: principalOf(request).id,
      });
      return reply.code(201).send(serialiseVersion(created));
    },
  );

  typed.post(
    '/versions/:id/promote',
    {
      ...promote,
      schema: {
        tags: ['strategies'],
        summary: 'Move a version one step along the ladder',
        description:
          'The ladder is DRAFT, BACKTEST, PAPER, REVIEW, APPROVED, LIVE. Steps ' +
          'cannot be skipped, approval requires a stop loss and is signed, and ' +
          'going LIVE is separate from being APPROVED so that approved never ' +
          'silently means running.',
        params: idParams,
        body: z.object({ stage: z.nativeEnum(StrategyStage) }),
        response: { 200: versionSchema },
      },
    },
    async (request, reply) => {
      const updated = await container.strategies.promote(request.params.id, request.body.stage, {
        id: principalOf(request).id,
      });
      return reply.send(serialiseVersion(updated));
    },
  );

  typed.post(
    '/:id/archive',
    {
      ...write,
      schema: {
        tags: ['strategies'],
        summary: 'Archive or unarchive a strategy',
        params: idParams,
        body: z.object({ archived: z.boolean() }),
        response: { 200: strategySchema },
      },
    },
    async (request, reply) => {
      const updated = await container.strategies.archive(request.params.id, request.body.archived);
      return reply.send(serialiseStrategy(updated));
    },
  );

  typed.post(
    '/versions/:id/evaluate',
    {
      ...signalRead,
      schema: {
        tags: ['signals'],
        summary: 'Evaluate a version and record any signals it produces',
        description:
          'A dry run may evaluate a draft. Either way the result is a ' +
          'recommendation at status CREATED — no route in this API can turn ' +
          'one into an order. Symbols the rule could not judge are returned ' +
          'under `notEvaluable`, never silently dropped.',
        params: idParams,
        body: z.object({
          portfolioId: z.string().uuid(),
          dryRun: z.boolean().default(false),
          at: z.string().datetime().optional(),
        }),
        response: { 200: evaluationSchema },
      },
    },
    async (request, reply) => {
      const portfolio = await container.access.assertPortfolioAccess(
        principalOf(request),
        request.body.portfolioId,
        { permission: Permission.SIGNAL_READ },
      );

      const result = await container.signals.evaluate({
        strategyVersionId: request.params.id,
        portfolioId: portfolio.id,
        allowNonLive: request.body.dryRun,
        ...(request.body.at ? { at: new Date(request.body.at) } : {}),
      });

      return reply.send({
        ...result,
        evaluatedAt: result.evaluatedAt.toISOString(),
      });
    },
  );

  typed.get(
    '/signals',
    {
      ...signalRead,
      schema: {
        tags: ['signals'],
        summary: 'Recent signals for a portfolio',
        querystring: z.object({
          portfolioId: z.string().uuid(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
        }),
        response: { 200: z.object({ signals: z.array(signalSchema) }) },
      },
    },
    async (request, reply) => {
      const portfolio = await container.access.assertPortfolioAccess(
        principalOf(request),
        request.query.portfolioId,
        { permission: Permission.SIGNAL_READ },
      );

      const rows = await container.db.signal.findMany({
        where: { portfolioId: portfolio.id },
        orderBy: { createdAt: 'desc' },
        take: request.query.limit,
        include: {
          strategy: { select: { name: true } },
          strategyVersion: { select: { version: true } },
        },
      });

      return reply.send({
        signals: rows.map((row) => ({
          id: row.id,
          signalKey: row.signalKey,
          symbol: row.symbol,
          direction: row.direction,
          status: row.status,
          referencePrice: row.referencePrice.toString(),
          suggestedStop: row.suggestedStop ? row.suggestedStop.toString() : null,
          suggestedTarget: row.suggestedTarget ? row.suggestedTarget.toString() : null,
          strategyName: row.strategy?.name ?? null,
          strategyVersion: row.strategyVersion?.version ?? null,
          conditionSnapshot: row.conditionSnapshot as Record<string, unknown>,
          createdAt: row.createdAt.toISOString(),
        })),
      });
    },
  );
}

type StrategyView = Awaited<ReturnType<AppContainer['strategies']['get']>>;
type VersionView = StrategyView['versions'][number];

function serialiseVersion(version: VersionView) {
  return {
    ...version,
    definition: version.definition as unknown as Record<string, unknown> | null,
    riskSettings: version.riskSettings as unknown as Record<string, unknown> | null,
    executionMode: version.executionMode as ExecutionMode,
    sessionScope: version.sessionScope as TradingSessionScope,
    approvedAt: version.approvedAt ? version.approvedAt.toISOString() : null,
    createdAt: version.createdAt.toISOString(),
  };
}

function serialiseStrategy(strategy: StrategyView) {
  return {
    ...strategy,
    versions: strategy.versions.map(serialiseVersion),
    liveVersion: strategy.liveVersion ? serialiseVersion(strategy.liveVersion) : null,
    latestVersion: strategy.latestVersion ? serialiseVersion(strategy.latestVersion) : null,
  };
}
