import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { Permission, decimalString, symbolSchema } from '@zusu/shared';
import type { AppContainer } from '../../container.js';
import { principalOf } from '../../plugins/auth.js';

const portfolioParams = z.object({ id: z.string().uuid() });

const brokerAccountSchema = z.object({
  accountId: z.string(),
  environment: z.enum(['DEMO', 'PAPER', 'LIVE']),
  currency: z.string(),
  cash: decimalString,
  buyingPower: decimalString,
  equity: decimalString,
  isPatternDayTrader: z.boolean(),
  updatedAt: z.string().datetime(),
});

const brokerPositionSchema = z.object({
  symbol: z.string(),
  assetClass: z.string(),
  quantity: decimalString,
  averageEntryPrice: decimalString,
  markPrice: decimalString,
  marketValue: decimalString,
  unrealizedPnl: decimalString,
  updatedAt: z.string().datetime(),
});

const quoteSchema = z.object({
  symbol: z.string(),
  provider: z.string(),
  price: decimalString,
  bid: decimalString,
  ask: decimalString,
  volume: decimalString,
  marketSession: z.string(),
  sourceTimestamp: z.string().datetime(),
  receivedTimestamp: z.string().datetime(),
});

/**
 * Read-only broker views.
 *
 * There is deliberately no order-placement endpoint in Phase 1: orders may only
 * ever be created behind the risk engine (Phase 7) and order manager (Phase 8).
 * Exposing a "place order" route now would mean shipping a path that bypasses
 * risk checks, which the build rules forbid.
 */
export async function registerBrokerRoutes(
  app: FastifyInstance,
  container: AppContainer,
): Promise<void> {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.get(
    '/:id/account',
    {
      preHandler: app.requirePermission(Permission.BROKER_ACCOUNT_READ),
      schema: {
        tags: ['broker'],
        summary: 'The broker’s own view of the account behind a portfolio',
        params: portfolioParams,
        response: { 200: brokerAccountSchema },
      },
    },
    async (request, reply) => {
      const portfolio = await container.access.assertPortfolioAccess(
        principalOf(request),
        request.params.id,
        { permission: Permission.BROKER_ACCOUNT_READ },
      );
      const account = await container.brokers.forPortfolio(portfolio).getAccount();
      return reply.send({
        accountId: account.accountId,
        environment: account.environment,
        currency: account.currency,
        cash: account.cash.toString(),
        buyingPower: account.buyingPower.toString(),
        equity: account.equity.toString(),
        isPatternDayTrader: account.isPatternDayTrader,
        updatedAt: account.updatedAt.toISOString(),
      });
    },
  );

  typed.get(
    '/:id/positions',
    {
      preHandler: app.requirePermission(Permission.BROKER_ACCOUNT_READ),
      schema: {
        tags: ['broker'],
        summary: 'Positions as the broker reports them (the reconciliation counterpart)',
        params: portfolioParams,
        response: { 200: z.array(brokerPositionSchema) },
      },
    },
    async (request, reply) => {
      const portfolio = await container.access.assertPortfolioAccess(
        principalOf(request),
        request.params.id,
        { permission: Permission.BROKER_ACCOUNT_READ },
      );
      const positions = await container.brokers.forPortfolio(portfolio).getPositions();
      return reply.send(
        positions.map((p) => ({
          symbol: p.symbol,
          assetClass: p.assetClass,
          quantity: p.quantity.toString(),
          averageEntryPrice: p.averageEntryPrice.toString(),
          markPrice: p.markPrice.toString(),
          marketValue: p.marketValue.toString(),
          unrealizedPnl: p.unrealizedPnl.toString(),
          updatedAt: p.updatedAt.toISOString(),
        })),
      );
    },
  );

  typed.get(
    '/:id/quote/:symbol',
    {
      preHandler: app.requirePermission(Permission.PORTFOLIO_READ),
      schema: {
        tags: ['broker'],
        summary: 'A quote from the portfolio environment’s market-data source',
        params: portfolioParams.extend({ symbol: symbolSchema }),
        response: { 200: quoteSchema },
      },
    },
    async (request, reply) => {
      const portfolio = await container.access.assertPortfolioAccess(
        principalOf(request),
        request.params.id,
        { permission: Permission.PORTFOLIO_READ },
      );
      const quote = await container.brokers.forPortfolio(portfolio).getQuote(request.params.symbol);
      return reply.send({
        symbol: quote.symbol,
        provider: quote.provider,
        price: quote.price.toString(),
        bid: quote.bid.toString(),
        ask: quote.ask.toString(),
        volume: quote.volume.toString(),
        marketSession: quote.marketSession,
        sourceTimestamp: quote.sourceTimestamp.toISOString(),
        receivedTimestamp: quote.receivedTimestamp.toISOString(),
      });
    },
  );
}
