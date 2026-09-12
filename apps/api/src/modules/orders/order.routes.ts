import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { OrderType, Permission, TimeInForce, dec } from '@zusu/shared';
import type { AppContainer } from '../../container.js';
import { principalOf } from '../../plugins/auth.js';

/**
 * Trading (§25, §36, §48).
 *
 * The route that matters is `POST /signals/:id/approve`. It is the only way a
 * recommendation becomes an order, it requires `signal:approve` plus trading
 * rights on the portfolio, and nothing in this codebase calls it but a person
 * pressing a button.
 *
 * There is no "auto-approve", no "approve all", and no setting that turns one
 * on. Full automation is not a feature flag here — it is a thing this platform
 * does not have.
 */

const idParams = z.object({ id: z.string().uuid() });

const executionSchema = z.object({
  id: z.string().uuid(),
  quantity: z.string(),
  price: z.string(),
  fees: z.string(),
  executedAt: z.string().datetime(),
});

const orderSchema = z.object({
  id: z.string().uuid(),
  idempotencyKey: z.string(),
  correlationId: z.string().uuid(),
  portfolioId: z.string().uuid(),
  signalId: z.string().uuid().nullable(),
  symbol: z.string(),
  side: z.string(),
  orderType: z.string(),
  timeInForce: z.string(),
  status: z.string(),
  environment: z.string(),
  requestedQty: z.string(),
  filledQty: z.string(),
  limitPrice: z.string().nullable(),
  stopPrice: z.string().nullable(),
  averageFillPrice: z.string().nullable(),
  expectedPrice: z.string().nullable(),
  slippage: z.string().nullable(),
  feesTotal: z.string(),
  rejectionReason: z.string().nullable(),
  brokerOrderId: z.string().nullable(),
  submittedAt: z.string().datetime().nullable(),
  filledAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  executions: z.array(executionSchema),
});

const lotSchema = z.object({
  id: z.string().uuid(),
  quantity: z.string(),
  remainingQty: z.string(),
  costBasis: z.string(),
  openedAt: z.string().datetime(),
  closedAt: z.string().datetime().nullable(),
  realizedGain: z.string(),
});

const positionSchema = z.object({
  id: z.string().uuid(),
  symbol: z.string(),
  status: z.string(),
  quantity: z.string(),
  averageEntryPrice: z.string(),
  markPrice: z.string().nullable(),
  realizedPnl: z.string(),
  /** Null when nothing has priced the symbol: a missing mark is not a zero. */
  unrealizedPnl: z.string().nullable(),
  feesTotal: z.string(),
  stopPrice: z.string().nullable(),
  targetPrice: z.string().nullable(),
  openedAt: z.string().datetime(),
  closedAt: z.string().datetime().nullable(),
  lots: z.array(lotSchema),
});

export async function registerOrderRoutes(
  app: FastifyInstance,
  container: AppContainer,
): Promise<void> {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const read = { preHandler: app.requirePermission(Permission.ORDER_READ) };
  const write = { preHandler: app.requirePermission(Permission.ORDER_WRITE) };
  const approve = { preHandler: app.requirePermission(Permission.SIGNAL_APPROVE) };

  typed.get(
    '/orders',
    {
      ...read,
      schema: {
        tags: ['trading'],
        summary: 'Recent orders for a portfolio',
        querystring: z.object({
          portfolioId: z.string().uuid(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
        }),
        response: { 200: z.object({ orders: z.array(orderSchema) }) },
      },
    },
    async (request, reply) => {
      const orders = await container.orders.list(
        principalOf(request),
        request.query.portfolioId,
        request.query.limit,
      );
      return reply.send({ orders: orders.map(serialiseOrder) });
    },
  );

  typed.get(
    '/orders/:id',
    {
      ...read,
      schema: {
        tags: ['trading'],
        summary: 'One order with its fills',
        params: idParams,
        response: { 200: orderSchema },
      },
    },
    async (request, reply) => {
      const order = await container.orders.get(principalOf(request), request.params.id);
      return reply.send(serialiseOrder(order));
    },
  );

  typed.post(
    '/orders/:id/sync',
    {
      ...read,
      schema: {
        tags: ['trading'],
        summary: 'Ask the broker what happened to an order',
        description:
          'Safe to call repeatedly: a fill already recorded is skipped, so ' +
          'polling cannot double a position.',
        params: idParams,
        response: { 200: orderSchema },
      },
    },
    async (request, reply) => {
      // Read permission is enough: this asks a question and applies the
      // answer, it does not decide anything.
      await container.orders.get(principalOf(request), request.params.id);
      const order = await container.orders.sync(request.params.id, principalOf(request));
      return reply.send(serialiseOrder(order));
    },
  );

  typed.post(
    '/orders',
    {
      ...write,
      schema: {
        tags: ['trading'],
        summary: 'Place an order by hand',
        description:
          'Requires trading rights on the portfolio. Runs the same gate and ' +
          'pre-trade checks an approved signal does; a refusal is stored as a ' +
          'rejected order with its reason rather than thrown away.',
        body: z.object({
          portfolioId: z.string().uuid(),
          symbol: z.string().min(1).max(12),
          side: z.enum(['BUY', 'SELL']),
          quantity: z.string(),
          orderType: z.nativeEnum(OrderType).default(OrderType.MARKET),
          timeInForce: z.nativeEnum(TimeInForce).default(TimeInForce.DAY),
          limitPrice: z.string().nullable().optional(),
          stopPrice: z.string().nullable().optional(),
          idempotencyKey: z.string().min(8).max(120).optional(),
        }),
        response: { 201: orderSchema },
      },
    },
    async (request, reply) => {
      const body = request.body;
      const order = await container.orders.placeOrder(principalOf(request), {
        portfolioId: body.portfolioId,
        symbol: body.symbol.toUpperCase(),
        side: body.side,
        quantity: body.quantity,
        orderType: body.orderType,
        timeInForce: body.timeInForce,
        ...(body.limitPrice !== undefined && { limitPrice: body.limitPrice }),
        ...(body.stopPrice !== undefined && { stopPrice: body.stopPrice }),
        ...(body.idempotencyKey !== undefined && { idempotencyKey: body.idempotencyKey }),
      });
      return reply.code(201).send(serialiseOrder(order));
    },
  );

  typed.post(
    '/orders/:id/cancel',
    {
      ...write,
      schema: {
        tags: ['trading'],
        summary: 'Cancel a resting order',
        params: idParams,
        response: { 200: orderSchema },
      },
    },
    async (request, reply) => {
      const order = await container.orders.cancel(principalOf(request), request.params.id);
      return reply.send(serialiseOrder(order));
    },
  );

  typed.post(
    '/signals/:id/approve',
    {
      ...approve,
      schema: {
        tags: ['trading'],
        summary: 'Approve a recommendation, creating an order',
        description:
          'The only path from a signal to a broker. It needs a person holding ' +
          '`signal:approve` and trading rights on the portfolio — there is no ' +
          'automated caller anywhere in this codebase, and no setting that ' +
          'creates one.',
        params: idParams,
        body: z.object({
          quantity: z.string().optional(),
          orderType: z.nativeEnum(OrderType).optional(),
          limitPrice: z.string().nullable().optional(),
          timeInForce: z.nativeEnum(TimeInForce).optional(),
          note: z.string().max(500).optional(),
        }),
        response: { 201: orderSchema },
      },
    },
    async (request, reply) => {
      const order = await container.orders.approveSignal(
        principalOf(request),
        request.params.id,
        request.body,
      );
      return reply.code(201).send(serialiseOrder(order));
    },
  );

  typed.post(
    '/signals/:id/reject',
    {
      ...approve,
      schema: {
        tags: ['trading'],
        summary: 'Reject a recommendation, with a reason',
        description:
          'The reason is required: a rejection is evidence about a strategy, ' +
          'and "no" tells a future reader nothing.',
        params: idParams,
        body: z.object({ reason: z.string().min(4).max(500) }),
        response: { 200: z.object({ id: z.string().uuid(), status: z.string() }) },
      },
    },
    async (request, reply) => {
      const result = await container.orders.rejectSignal(
        principalOf(request),
        request.params.id,
        request.body.reason,
      );
      return reply.send(result);
    },
  );

  typed.get(
    '/positions',
    {
      preHandler: app.requirePermission(Permission.POSITION_READ),
      schema: {
        tags: ['trading'],
        summary: 'Positions with their tax lots',
        querystring: z.object({
          portfolioId: z.string().uuid(),
          includeClosed: z.coerce.boolean().default(false),
        }),
        response: { 200: z.object({ positions: z.array(positionSchema) }) },
      },
    },
    async (request, reply) => {
      const portfolio = await container.access.assertPortfolioAccess(
        principalOf(request),
        request.query.portfolioId,
        { permission: Permission.POSITION_READ },
      );

      const rows = await container.db.position.findMany({
        where: {
          portfolioId: portfolio.id,
          ...(request.query.includeClosed ? {} : { status: 'OPEN' }),
        },
        orderBy: [{ status: 'asc' }, { openedAt: 'desc' }],
        include: { lots: { orderBy: { openedAt: 'asc' } } },
      });

      // Marks are computed on read from the newest stored bar rather than
      // served from the column, which is only written at fill time. A stale
      // `unrealizedPnl` of 0 would read as "flat" when it means "not priced
      // since", so a symbol with no stored price returns null instead.
      const marks = new Map<string, string | null>();
      for (const row of rows) {
        if (marks.has(row.symbol)) continue;
        const candle = await container.db.marketDataCandle.findFirst({
          where: { symbol: row.symbol },
          orderBy: { openTime: 'desc' },
          select: { close: true },
        });
        marks.set(row.symbol, candle ? candle.close.toString() : null);
      }

      return reply.send({
        positions: rows.map((row) => ({
          id: row.id,
          symbol: row.symbol,
          status: row.status,
          quantity: row.quantity.toString(),
          averageEntryPrice: row.averageEntryPrice.toString(),
          markPrice: marks.get(row.symbol) ?? null,
          realizedPnl: row.realizedPnl.toString(),
          unrealizedPnl: unrealisedFor(row, marks.get(row.symbol) ?? null),
          feesTotal: row.feesTotal.toString(),
          stopPrice: row.stopPrice ? row.stopPrice.toString() : null,
          targetPrice: row.targetPrice ? row.targetPrice.toString() : null,
          openedAt: row.openedAt.toISOString(),
          closedAt: row.closedAt ? row.closedAt.toISOString() : null,
          lots: row.lots.map((lot) => ({
            id: lot.id,
            quantity: lot.quantity.toString(),
            remainingQty: lot.remainingQty.toString(),
            costBasis: lot.costBasis.toString(),
            openedAt: lot.openedAt.toISOString(),
            closedAt: lot.closedAt ? lot.closedAt.toISOString() : null,
            realizedGain: lot.realizedGain.toString(),
          })),
        })),
      });
    },
  );
}

/** Mark-to-market against the newest stored price, or null without one. */
function unrealisedFor(
  row: { quantity: { toString(): string }; averageEntryPrice: { toString(): string } },
  mark: string | null,
): string | null {
  if (mark === null) return null;
  return dec(mark)
    .minus(dec(row.averageEntryPrice.toString()))
    .times(dec(row.quantity.toString()))
    .toString();
}

type Order = Awaited<ReturnType<AppContainer['orders']['list']>>[number];

function serialiseOrder(order: Order) {
  return {
    ...order,
    submittedAt: order.submittedAt ? order.submittedAt.toISOString() : null,
    filledAt: order.filledAt ? order.filledAt.toISOString() : null,
    createdAt: order.createdAt.toISOString(),
    executions: order.executions.map((execution) => ({
      ...execution,
      executedAt: execution.executedAt.toISOString(),
    })),
  };
}
