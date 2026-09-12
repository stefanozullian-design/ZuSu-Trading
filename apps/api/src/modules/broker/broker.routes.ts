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

const differenceSchema = z.object({
  kind: z.enum([
    'CASH',
    'POSITION_QUANTITY',
    'POSITION_PRICE',
    'POSITION_MISSING_HERE',
    'POSITION_MISSING_AT_BROKER',
    'ORDER_PLACED_ELSEWHERE',
  ]),
  symbol: z.string().nullable(),
  ours: z.string().nullable(),
  theirs: z.string().nullable(),
  detail: z.string(),
});

const reconciliationSchema = z.object({
  id: z.string(),
  portfolioId: z.string(),
  succeeded: z.boolean(),
  cashMismatch: z.boolean(),
  positionMismatch: z.boolean(),
  orderMismatch: z.boolean(),
  differences: z.array(differenceSchema),
  detail: z.string(),
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
 * Read-only broker views, plus reconciliation.
 *
 * There is deliberately no order-placement endpoint here. Orders are created
 * only behind the risk engine and the order manager, on `/api/trading`, and a
 * second path to a broker would be a path around those checks.
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

  typed.post(
    '/:id/reconcile',
    {
      preHandler: app.requirePermission(Permission.BROKER_ACCOUNT_READ),
      schema: {
        tags: ['broker'],
        summary: 'Compare this platform’s record of a portfolio against the broker’s',
        description:
          'Reads both records and reports every difference. It never writes a correction: ' +
          'the value of keeping two records is that they can disagree, and the disagreement ' +
          'is the finding. A person decides which side is right.',
        params: portfolioParams,
        response: { 200: reconciliationSchema },
      },
    },
    async (request, reply) => {
      const portfolio = await container.access.assertPortfolioAccess(
        principalOf(request),
        request.params.id,
        { permission: Permission.BROKER_ACCOUNT_READ },
      );
      const result = await container.reconciliation.run(portfolio.id);
      return reply.send(result);
    },
  );

  typed.get(
    '/:id/reconciliations',
    {
      preHandler: app.requirePermission(Permission.BROKER_ACCOUNT_READ),
      schema: {
        tags: ['broker'],
        summary: 'Past reconciliation runs for a portfolio, newest first',
        params: portfolioParams,
        querystring: z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) }),
        response: { 200: z.array(reconciliationSchema) },
      },
    },
    async (request, reply) => {
      const portfolio = await container.access.assertPortfolioAccess(
        principalOf(request),
        request.params.id,
        { permission: Permission.BROKER_ACCOUNT_READ },
      );
      const rows = await container.reconciliation.recent(portfolio.id, request.query.limit);
      return reply.send(rows);
    },
  );
}
