import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { Permission, dec, decimalString, killSwitchRequestSchema } from '@zusu/shared';
import type { AppContainer } from '../../container.js';
import { principalOf } from '../../plugins/auth.js';

const idParams = z.object({ id: z.string().uuid() });

const gateDecisionSchema = z.object({
  portfolioId: z.string().uuid(),
  allowed: z.boolean(),
  blockers: z.array(
    z.object({
      code: z.string(),
      message: z.string(),
      severity: z.enum(['BLOCKING', 'WARNING']),
    }),
  ),
  checkedAt: z.string().datetime(),
});

const riskLimitsSchema = z.object({
  portfolioId: z.string().uuid(),
  version: z.number().int(),
  maxDailyLoss: decimalString,
  maxWeeklyLoss: decimalString,
  maxPositionSize: decimalString,
  maxPortfolioExposurePct: decimalString,
  maxSectorExposurePct: decimalString,
  maxSymbolExposurePct: decimalString,
  maxOpenPositions: z.number().int(),
  maxTradesPerDay: z.number().int(),
  maxConsecutiveLosses: z.number().int(),
  maxDrawdownPct: decimalString,
});

export async function registerRiskRoutes(
  app: FastifyInstance,
  container: AppContainer,
): Promise<void> {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.get(
    '/portfolios/:id/gate',
    {
      preHandler: app.requirePermission(Permission.RISK_READ),
      schema: {
        tags: ['risk'],
        summary: 'Whether this portfolio may trade right now, and what is blocking it',
        description:
          'The same decision the order manager will enforce before submitting an order. ' +
          'Portfolio limits (daily loss, exposure, correlation, drawdown) are checked ' +
          'alongside it on every order.',
        params: idParams,
        response: { 200: gateDecisionSchema },
      },
    },
    async (request, reply) => {
      const portfolio = await container.access.assertPortfolioAccess(
        principalOf(request),
        request.params.id,
        { permission: Permission.RISK_READ },
      );
      return reply.send(await container.gate.evaluate(portfolio));
    },
  );

  typed.get(
    '/portfolios/:id/limits',
    {
      preHandler: app.requirePermission(Permission.RISK_READ),
      schema: {
        tags: ['risk'],
        summary: 'Active risk limits for a portfolio',
        params: idParams,
        response: { 200: riskLimitsSchema },
      },
    },
    async (request, reply) => {
      const portfolio = await container.access.assertPortfolioAccess(
        principalOf(request),
        request.params.id,
        { permission: Permission.RISK_READ },
      );
      const limits = await container.db.riskLimit.findFirstOrThrow({
        where: { portfolioId: portfolio.id, isActive: true },
      });
      return reply.send({
        portfolioId: limits.portfolioId,
        version: limits.version,
        maxDailyLoss: limits.maxDailyLoss.toString(),
        maxWeeklyLoss: limits.maxWeeklyLoss.toString(),
        maxPositionSize: limits.maxPositionSize.toString(),
        maxPortfolioExposurePct: limits.maxPortfolioExposurePct.toString(),
        maxSectorExposurePct: limits.maxSectorExposurePct.toString(),
        maxSymbolExposurePct: limits.maxSymbolExposurePct.toString(),
        maxOpenPositions: limits.maxOpenPositions,
        maxTradesPerDay: limits.maxTradesPerDay,
        maxConsecutiveLosses: limits.maxConsecutiveLosses,
        maxDrawdownPct: limits.maxDrawdownPct.toString(),
      });
    },
  );

  typed.post(
    '/kill-switch',
    {
      preHandler: app.requirePermission(Permission.KILL_SWITCH_ACTIVATE),
      schema: {
        tags: ['risk'],
        summary: 'Stop all trading',
        description:
          'Halts the named portfolio, or every portfolio the caller can reach. Resting entry ' +
          'orders are cancelled; open positions are left untouched and keep being monitored.',
        body: killSwitchRequestSchema,
        response: {
          200: z.object({
            portfoliosHalted: z.array(z.string().uuid()),
            ordersCancelled: z.number().int(),
            reason: z.string(),
            engagedAt: z.string().datetime(),
          }),
        },
      },
    },
    async (request, reply) => {
      const result = await container.killSwitch.engage(principalOf(request), request.body, {
        ip: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      });
      return reply.send(result);
    },
  );

  typed.post(
    '/portfolios/:id/resume',
    {
      preHandler: app.requirePermission(Permission.KILL_SWITCH_RELEASE),
      schema: {
        tags: ['risk'],
        summary: 'Release a halt (administrators only)',
        params: idParams,
        body: z.object({ reason: z.string().trim().min(3).max(500) }),
        response: {
          200: z.object({
            portfolioId: z.string().uuid(),
            tradingState: z.enum(['ACTIVE', 'HALTED', 'RECONCILIATION_ERROR']),
          }),
        },
      },
    },
    async (request, reply) => {
      const result = await container.killSwitch.release(
        principalOf(request),
        request.params.id,
        request.body.reason,
        { ip: request.ip, userAgent: request.headers['user-agent'] ?? null },
      );
      return reply.send(result);
    },
  );

  typed.post(
    '/portfolios/:id/assess',
    {
      preHandler: app.requirePermission(Permission.RISK_READ),
      schema: {
        tags: ['risk'],
        summary: 'Size a proposed trade and check it against the whole book',
        description:
          'Changes nothing. Every check names its limit, the limit value and ' +
          'the actual value, because a refusal that says only "risk limit ' +
          'exceeded" cannot be acted on.',
        params: idParams,
        body: z.object({
          symbol: z.string().min(1).max(12),
          direction: z.enum(['LONG', 'SHORT']).default('LONG'),
          entryPrice: z.string(),
          stopPrice: z.string().nullable().optional(),
          quantity: z.string().optional(),
          riskPerTradePct: z.string().optional(),
        }),
        response: {
          200: z.object({
            allowed: z.boolean(),
            checks: z.array(
              z.object({
                limitName: z.string(),
                passed: z.boolean(),
                actual: z.string().nullable(),
                limit: z.string(),
                message: z.string(),
                severity: z.string(),
              }),
            ),
            breaches: z.array(z.record(z.unknown())),
            nearMisses: z.array(z.record(z.unknown())),
            sizing: z
              .object({
                quantity: z.string(),
                riskAmount: z.string(),
                riskPerShare: z.string().nullable(),
                notional: z.string(),
                boundBy: z.string(),
                reason: z.string().nullable(),
                volatilityFloorApplied: z.boolean(),
              })
              .nullable(),
          }),
        },
      },
    },
    async (request, reply) => {
      const portfolio = await container.access.assertPortfolioAccess(
        principalOf(request),
        request.params.id,
        { permission: Permission.RISK_READ },
      );

      const body = request.body;
      const assessment = await container.risk.assess({
        portfolioId: portfolio.id,
        symbol: body.symbol.toUpperCase(),
        side: body.direction === 'LONG' ? 'BUY' : 'SELL',
        direction: body.direction,
        entryPrice: dec(body.entryPrice),
        stopPrice: body.stopPrice ? dec(body.stopPrice) : null,
        ...(body.quantity !== undefined && { quantity: dec(body.quantity) }),
        ...(body.riskPerTradePct !== undefined && {
          riskPerTradePct: dec(body.riskPerTradePct),
        }),
      });

      return reply.send({
        allowed: assessment.allowed,
        checks: assessment.checks,
        breaches: assessment.breaches as unknown as Record<string, unknown>[],
        nearMisses: assessment.nearMisses as unknown as Record<string, unknown>[],
        sizing: assessment.sizing
          ? {
              quantity: assessment.sizing.quantity.toString(),
              riskAmount: assessment.sizing.riskAmount.toString(),
              riskPerShare: assessment.sizing.riskPerShare
                ? assessment.sizing.riskPerShare.toString()
                : null,
              notional: assessment.sizing.notional.toString(),
              boundBy: assessment.sizing.boundBy,
              reason: assessment.sizing.reason,
              volatilityFloorApplied: assessment.sizing.volatilityFloorApplied,
            }
          : null,
      });
    },
  );

  typed.get(
    '/portfolios/:id/events',
    {
      preHandler: app.requirePermission(Permission.RISK_READ),
      schema: {
        tags: ['risk'],
        summary: 'Recent risk events for a portfolio',
        description:
          'Breaches and near-misses both. A pattern of near-misses is what ' +
          'makes the eventual breach unsurprising.',
        params: idParams,
        querystring: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }),
        response: {
          200: z.object({
            events: z.array(
              z.object({
                id: z.string().uuid(),
                type: z.string(),
                severity: z.string(),
                message: z.string(),
                limitName: z.string().nullable(),
                limitValue: z.string().nullable(),
                actualValue: z.string().nullable(),
                createdAt: z.string().datetime(),
              }),
            ),
          }),
        },
      },
    },
    async (request, reply) => {
      const portfolio = await container.access.assertPortfolioAccess(
        principalOf(request),
        request.params.id,
        { permission: Permission.RISK_READ },
      );

      const events = await container.risk.recentEvents(portfolio.id, request.query.limit);
      return reply.send({
        events: events.map((event) => ({
          id: event.id,
          type: event.type,
          severity: event.severity,
          message: event.message,
          limitName: event.limitName,
          limitValue: event.limitValue ? event.limitValue.toString() : null,
          actualValue: event.actualValue ? event.actualValue.toString() : null,
          createdAt: event.createdAt.toISOString(),
        })),
      });
    },
  );
}
