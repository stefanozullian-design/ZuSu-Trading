import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import {
  AssetClass,
  Decimal,
  OrderStatus,
  OrderType,
  Permission,
  SignalStatus,
  TimeInForce,
  TradingEnvironment,
  assertOrderTransition,
  dec,
} from '@zusu/shared';
import { AppError } from '../../lib/errors.js';
import type { AuditService } from '../audit/audit.service.js';
import type { BrokerRegistry } from '../broker/broker-registry.js';
import type { BrokerOrder } from '../broker/types.js';
import { BrokerError } from '../broker/types.js';
import type { AccessControl, Principal } from '../rbac/access-control.js';
import type { TradingGate } from '../risk/trading-gate.js';
import { applyFill } from './position-book.js';

/**
 * Orders (§25, §26, §36, §48).
 *
 * This is the module the whole platform is arranged around, and the rule it
 * exists to enforce is the product's premise: **a signal becomes an order only
 * by a person's act.** There is no code path from a strategy, a scanner or a
 * model to `placeOrder` — the only callers are the approval route and a manual
 * order, both of which require a human principal holding `signal:approve` or
 * `order:write`.
 *
 * Everything else here is about making that act survivable:
 *
 *   - **Every order carries an idempotency key** and the column is unique, so
 *     a retry, a double-click or a replayed request cannot open a second
 *     position. The key is derived from the signal for an approval, so even
 *     two people approving the same signal at once produce one order.
 *
 *   - **An execution is ingested once.** `brokerExecId` is unique; a poll that
 *     returns a fill already recorded changes nothing. Without that, syncing
 *     an order twice would double the position.
 *
 *   - **The state machine is the shared one.** A status this module cannot
 *     justify is a status it cannot write, because `assertOrderTransition`
 *     refuses. A transport failure leaves an order UNKNOWN, never CANCELLED:
 *     "we do not know" is a state, and pretending otherwise is how a position
 *     nobody knows about gets opened.
 *
 *   - **A rejected order is a row.** Nothing is discarded, so "why did this
 *     not trade" always has an answer.
 */

/**
 * Portfolio-level limits this module does not yet enforce.
 *
 * Listed rather than silently absent: a caller reading a successful pre-trade
 * check should know exactly what it did and did not verify. The risk engine
 * in Phase 7 owns these, and until it exists a person is the only thing
 * standing between a strategy and a concentrated book.
 */
export const LIMITS_NOT_YET_ENFORCED = [
  'daily and weekly loss limits',
  'portfolio, sector and symbol exposure percentages',
  'correlation between open positions',
  'drawdown-triggered circuit breakers',
  'consecutive-loss limits',
] as const;

export interface PreTradeCheck {
  passed: boolean;
  /** Why it failed, in a sentence a person can act on. */
  reason: string | null;
  checked: string[];
  notYetEnforced: readonly string[];
}

export interface PlaceOrderInput {
  portfolioId: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  quantity: string;
  orderType?: OrderType;
  timeInForce?: TimeInForce;
  limitPrice?: string | null;
  stopPrice?: string | null;
  expectedPrice?: string | null;
  /** Supplied by the caller for a retry-safe submission; derived otherwise. */
  idempotencyKey?: string;
  signalId?: string | null;
  strategyId?: string | null;
  /** Recorded on the position when it opens. */
  stopForPosition?: string | null;
  targetForPosition?: string | null;
  at?: Date;
}

export interface OrderView {
  id: string;
  idempotencyKey: string;
  correlationId: string;
  portfolioId: string;
  signalId: string | null;
  symbol: string;
  side: string;
  orderType: string;
  timeInForce: string;
  status: string;
  environment: string;
  requestedQty: string;
  filledQty: string;
  limitPrice: string | null;
  stopPrice: string | null;
  averageFillPrice: string | null;
  expectedPrice: string | null;
  slippage: string | null;
  feesTotal: string;
  rejectionReason: string | null;
  brokerOrderId: string | null;
  submittedAt: Date | null;
  filledAt: Date | null;
  createdAt: Date;
  executions: {
    id: string;
    quantity: string;
    price: string;
    fees: string;
    executedAt: Date;
  }[];
}

export class OrderService {
  constructor(
    private readonly db: PrismaClient,
    private readonly access: AccessControl,
    private readonly audit: AuditService,
    private readonly brokers: BrokerRegistry,
    private readonly gate: TradingGate,
  ) {}

  async list(principal: Principal, portfolioId: string, limit = 50): Promise<OrderView[]> {
    const portfolio = await this.access.assertPortfolioAccess(principal, portfolioId, {
      permission: Permission.ORDER_READ,
    });

    const rows = await this.db.order.findMany({
      where: { portfolioId: portfolio.id },
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: { executions: { orderBy: { executedAt: 'asc' } } },
    });
    return rows.map(toView);
  }

  async get(principal: Principal, orderId: string): Promise<OrderView> {
    const row = await this.db.order.findUnique({
      where: { id: orderId },
      include: { executions: { orderBy: { executedAt: 'asc' } } },
    });
    if (!row) throw new AppError('NOT_FOUND', 'Order not found');
    await this.access.assertPortfolioAccess(principal, row.portfolioId, {
      permission: Permission.ORDER_READ,
    });
    return toView(row);
  }

  /**
   * Turns an approved recommendation into an order.
   *
   * The only automated part is the arithmetic. A person supplies the approval,
   * and this method refuses to proceed without one: a signal that has not been
   * approved by somebody holding `signal:approve` cannot reach a broker.
   */
  async approveSignal(
    principal: Principal,
    signalId: string,
    input: {
      quantity?: string;
      orderType?: OrderType;
      limitPrice?: string | null;
      timeInForce?: TimeInForce;
      note?: string;
      at?: Date;
    } = {},
  ): Promise<OrderView> {
    this.access.assertPermission(principal, Permission.SIGNAL_APPROVE);

    const signal = await this.db.signal.findUnique({ where: { id: signalId } });
    if (!signal) throw new AppError('NOT_FOUND', 'Signal not found');

    const portfolio = await this.access.assertPortfolioAccess(principal, signal.portfolioId, {
      permission: Permission.ORDER_WRITE,
      requireTrade: true,
    });

    const status = signal.status as SignalStatus;
    if (status !== SignalStatus.CREATED && status !== SignalStatus.PENDING_APPROVAL) {
      throw new AppError(
        'CONFLICT',
        `This signal is ${signal.status}, so there is nothing to approve. ` +
          'An approval applies to a recommendation that is still waiting.',
      );
    }

    const quantity = input.quantity ? dec(input.quantity) : await this.sizeFor(signal, portfolio);
    if (quantity.lessThanOrEqualTo(0)) {
      throw new AppError(
        'VALIDATION_FAILED',
        'The approved quantity must be positive. A zero-share order is not an approval.',
      );
    }

    // The signal walks its own ladder: CREATED → RISK_CHECK → APPROVED, each
    // step recorded, so "who approved this and when" is answerable.
    await this.moveSignal(signal.id, status, SignalStatus.RISK_CHECK, principal, 'pre-trade check');

    const order = await this.placeOrder(principal, {
      portfolioId: signal.portfolioId,
      symbol: signal.symbol,
      side: signal.direction === 'LONG' ? 'BUY' : 'SELL',
      quantity: quantity.toString(),
      ...(input.orderType !== undefined && { orderType: input.orderType }),
      ...(input.timeInForce !== undefined && { timeInForce: input.timeInForce }),
      ...(input.limitPrice !== undefined && { limitPrice: input.limitPrice }),
      expectedPrice: signal.referencePrice.toString(),
      // Derived from the signal, so two people approving at once produce one
      // order rather than two positions.
      idempotencyKey: `signal:${signal.id}`,
      signalId: signal.id,
      strategyId: signal.strategyId,
      stopForPosition: signal.suggestedStop ? signal.suggestedStop.toString() : null,
      targetForPosition: signal.suggestedTarget ? signal.suggestedTarget.toString() : null,
      ...(input.at !== undefined && { at: input.at }),
    });

    await this.audit.record({
      action: 'SIGNAL_APPROVED',
      actorUserId: principal.id,
      actorType: 'USER',
      entityType: 'signal',
      entityId: signal.id,
      portfolioId: signal.portfolioId,
      environment: portfolio.environment as TradingEnvironment,
      after: { orderId: order.id, quantity: quantity.toString() },
      metadata: input.note ? { note: input.note } : null,
    });

    return order;
  }

  async rejectSignal(
    principal: Principal,
    signalId: string,
    reason: string,
  ): Promise<{ id: string; status: string }> {
    this.access.assertPermission(principal, Permission.SIGNAL_APPROVE);
    if (reason.trim().length < 4) {
      // A rejection is evidence about a strategy. "no" tells a future reader
      // nothing about why.
      throw new AppError('VALIDATION_FAILED', 'Say why it was rejected, in a few words at least');
    }

    const signal = await this.db.signal.findUnique({ where: { id: signalId } });
    if (!signal) throw new AppError('NOT_FOUND', 'Signal not found');
    await this.access.assertPortfolioAccess(principal, signal.portfolioId, {
      permission: Permission.SIGNAL_APPROVE,
    });

    const from = signal.status as SignalStatus;
    await this.moveSignal(signal.id, from, SignalStatus.REJECTED, principal, reason.trim());

    await this.audit.record({
      action: 'SIGNAL_REJECTED',
      actorUserId: principal.id,
      actorType: 'USER',
      entityType: 'signal',
      entityId: signal.id,
      portfolioId: signal.portfolioId,
      metadata: { reason: reason.trim() },
    });

    return { id: signal.id, status: SignalStatus.REJECTED };
  }

  /**
   * Places an order. The single door to a broker.
   *
   * Requires `order:write` and trade access on the portfolio, so the caller is
   * always a person acting deliberately — an approval, or a manual trade.
   */
  async placeOrder(principal: Principal, input: PlaceOrderInput): Promise<OrderView> {
    const portfolio = await this.access.assertPortfolioAccess(principal, input.portfolioId, {
      permission: Permission.ORDER_WRITE,
      requireTrade: true,
    });

    const at = input.at ?? new Date();
    const quantity = dec(input.quantity);
    if (quantity.lessThanOrEqualTo(0)) {
      throw new AppError('VALIDATION_FAILED', 'Quantity must be positive');
    }

    const idempotencyKey = input.idempotencyKey ?? `manual:${randomUUID()}`;
    const existing = await this.db.order.findUnique({
      where: { idempotencyKey },
      include: { executions: { orderBy: { executedAt: 'asc' } } },
    });
    if (existing) {
      // The key already placed an order. Returning it is the whole point of
      // the key: a retry must not become a second position.
      return this.sync(existing.id);
    }

    // The gate is consulted before anything is written, and it is the same
    // object the risk engine will extend: halted trading, a dead feed, a
    // closed market or a halted symbol all stop the order here.
    await this.gate.assertCanTrade(portfolio.id, { symbol: input.symbol, at });

    const check = await this.preTradeCheck(portfolio.id, input.symbol, quantity, input.side, at);

    const correlationId = randomUUID();
    const order = await this.db.order.create({
      data: {
        idempotencyKey,
        correlationId,
        portfolioId: portfolio.id,
        signalId: input.signalId ?? null,
        strategyId: input.strategyId ?? null,
        environment: portfolio.environment,
        symbol: input.symbol,
        assetClass: 'EQUITY',
        side: input.side,
        orderType: input.orderType ?? OrderType.MARKET,
        timeInForce: input.timeInForce ?? TimeInForce.DAY,
        status: OrderStatus.CREATED,
        requestedQty: quantity.toString(),
        limitPrice: input.limitPrice ?? null,
        stopPrice: input.stopPrice ?? null,
        expectedPrice: input.expectedPrice ?? null,
      },
    });

    await this.recordEvent(order.id, null, OrderStatus.CREATED, principal, 'created');

    if (!check.passed) {
      // A refusal is a row with a reason, not a thrown error and no trace.
      await this.transition(order.id, OrderStatus.CREATED, OrderStatus.REJECTED, principal, {
        reason: check.reason ?? 'pre-trade check failed',
        data: { rejectionReason: check.reason },
      });
      await this.audit.record({
        action: 'ORDER_REJECTED',
        actorUserId: principal.id,
        actorType: 'USER',
        entityType: 'order',
        entityId: order.id,
        portfolioId: portfolio.id,
        correlationId,
        metadata: { reason: check.reason, checked: check.checked },
      });
      return this.viewOf(order.id);
    }

    const broker = this.brokers.forPortfolio(portfolio);

    let brokerOrder: BrokerOrder;
    try {
      await this.transition(order.id, OrderStatus.CREATED, OrderStatus.SUBMITTED, principal, {
        reason: 'submitted to the broker',
        data: { submittedAt: at },
      });

      brokerOrder = await broker.placeOrder({
        idempotencyKey,
        symbol: input.symbol,
        assetClass: AssetClass.EQUITY,
        side: input.side,
        orderType: input.orderType ?? OrderType.MARKET,
        timeInForce: input.timeInForce ?? TimeInForce.DAY,
        quantity,
        limitPrice: input.limitPrice ? dec(input.limitPrice) : null,
        stopPrice: input.stopPrice ? dec(input.stopPrice) : null,
        expectedPrice: input.expectedPrice ? dec(input.expectedPrice) : null,
      });
    } catch (error) {
      const retryable = error instanceof BrokerError && error.retryable;
      // A retryable failure means the broker may or may not have the order:
      // UNKNOWN says exactly that, and reconciliation resolves it. Marking it
      // CANCELLED would be a guess that could hide a live position.
      await this.transition(
        order.id,
        OrderStatus.SUBMITTED,
        retryable ? OrderStatus.UNKNOWN : OrderStatus.REJECTED,
        principal,
        {
          reason: error instanceof Error ? error.message : 'broker call failed',
          data: {
            rejectionReason: error instanceof Error ? error.message : 'broker call failed',
          },
        },
      );
      if (input.signalId) {
        await this.moveSignal(
          input.signalId,
          SignalStatus.RISK_CHECK,
          SignalStatus.FAILED,
          principal,
          'the broker refused the order',
        );
      }
      return this.viewOf(order.id);
    }

    await this.db.order.update({
      where: { id: order.id },
      data: {
        brokerOrderId: brokerOrder.brokerOrderId,
        acknowledgedAt: brokerOrder.updatedAt,
        brokerResponse: { status: brokerOrder.status } as unknown as Prisma.InputJsonValue,
      },
    });

    if (input.signalId) {
      await this.moveSignal(
        input.signalId,
        SignalStatus.RISK_CHECK,
        SignalStatus.APPROVED,
        principal,
        'approved by a person',
      );
      await this.moveSignal(
        input.signalId,
        SignalStatus.APPROVED,
        SignalStatus.ORDER_SUBMITTED,
        principal,
        'order submitted',
      );
    }

    await this.ingest(order.id, brokerOrder, principal, {
      stopForPosition: input.stopForPosition ?? null,
      targetForPosition: input.targetForPosition ?? null,
    });

    await this.audit.record({
      action: 'ORDER_SUBMITTED',
      actorUserId: principal.id,
      actorType: 'USER',
      entityType: 'order',
      entityId: order.id,
      portfolioId: portfolio.id,
      correlationId,
      environment: portfolio.environment as TradingEnvironment,
      after: {
        symbol: input.symbol,
        side: input.side,
        quantity: quantity.toString(),
        brokerOrderId: brokerOrder.brokerOrderId,
      },
      metadata: { notYetEnforced: [...check.notYetEnforced] },
    });

    return this.viewOf(order.id);
  }

  /** Polls the broker and applies anything new. Safe to call repeatedly. */
  async sync(orderId: string, principal?: Principal): Promise<OrderView> {
    const order = await this.db.order.findUnique({
      where: { id: orderId },
      include: { portfolio: true },
    });
    if (!order) throw new AppError('NOT_FOUND', 'Order not found');
    if (!order.brokerOrderId) return this.viewOf(orderId);

    const broker = this.brokers.forPortfolio(order.portfolio);
    const brokerOrder = await broker.getOrderStatus(order.brokerOrderId);
    await this.ingest(orderId, brokerOrder, principal ?? null, {
      stopForPosition: null,
      targetForPosition: null,
    });
    return this.viewOf(orderId);
  }

  async cancel(principal: Principal, orderId: string): Promise<OrderView> {
    const order = await this.db.order.findUnique({
      where: { id: orderId },
      include: { portfolio: true },
    });
    if (!order) throw new AppError('NOT_FOUND', 'Order not found');
    await this.access.assertPortfolioAccess(principal, order.portfolioId, {
      permission: Permission.ORDER_WRITE,
      requireTrade: true,
    });
    if (!order.brokerOrderId) {
      throw new AppError(
        'CONFLICT',
        'This order never reached a broker, so there is nothing to cancel',
      );
    }

    await this.transition(
      order.id,
      order.status as OrderStatus,
      OrderStatus.CANCEL_REQUESTED,
      principal,
      { reason: 'cancellation requested' },
    );

    const broker = this.brokers.forPortfolio(order.portfolio);
    const cancelled = await broker.cancelOrder(order.brokerOrderId);
    await this.ingest(order.id, cancelled, principal, {
      stopForPosition: null,
      targetForPosition: null,
    });
    return this.viewOf(order.id);
  }

  /**
   * The pre-trade checks this module can make today.
   *
   * Deliberately narrow, and it says so: the three limits below are per-order
   * facts available without a risk engine. Everything in
   * `LIMITS_NOT_YET_ENFORCED` is absent, and a caller is told rather than left
   * to assume a full risk check happened.
   */
  async preTradeCheck(
    portfolioId: string,
    symbol: string,
    quantity: Decimal,
    side: 'BUY' | 'SELL',
    at: Date,
  ): Promise<PreTradeCheck> {
    const checked = ['position size', 'open position count', 'trades today', 'cash on hand'];
    const result = (passed: boolean, reason: string | null): PreTradeCheck => ({
      passed,
      reason,
      checked,
      notYetEnforced: LIMITS_NOT_YET_ENFORCED,
    });

    const limits = await this.db.riskLimit.findFirst({
      where: { portfolioId, isActive: true },
      orderBy: { version: 'desc' },
    });
    if (!limits) {
      // No limits configured is not a green light.
      return result(false, 'This portfolio has no active risk limits, so no order may be placed.');
    }

    const [portfolio, openPositions, tradesToday, latestCandle] = await Promise.all([
      this.db.portfolio.findUniqueOrThrow({ where: { id: portfolioId } }),
      this.db.position.count({ where: { portfolioId, status: 'OPEN' } }),
      this.db.order.count({
        where: {
          portfolioId,
          createdAt: { gte: startOfUtcDay(at) },
          status: { notIn: [OrderStatus.REJECTED] },
        },
      }),
      this.db.marketDataCandle.findFirst({
        where: { symbol },
        orderBy: { openTime: 'desc' },
        select: { close: true },
      }),
    ]);

    if (!latestCandle) {
      return result(
        false,
        `No stored price for ${symbol}, so the order cannot be sized or risk-checked.`,
      );
    }

    const price = dec(latestCandle.close.toString());
    const notional = price.times(quantity);

    if (notional.greaterThan(dec(limits.maxPositionSize.toString()))) {
      return result(
        false,
        `${notional.toFixed(2)} exceeds the ${dec(limits.maxPositionSize.toString()).toFixed(2)} ` +
          'maximum position size on this portfolio.',
      );
    }

    if (side === 'BUY' && notional.greaterThan(dec(portfolio.cashBalance.toString()))) {
      return result(
        false,
        `${notional.toFixed(2)} exceeds the ${dec(portfolio.cashBalance.toString()).toFixed(2)} ` +
          'of cash on hand. This platform does not model margin.',
      );
    }

    const existing = await this.db.position.findFirst({
      where: { portfolioId, symbol, status: 'OPEN' },
    });
    if (!existing && openPositions >= limits.maxOpenPositions) {
      return result(
        false,
        `${String(openPositions)} positions are already open, which is the configured maximum.`,
      );
    }

    if (tradesToday >= limits.maxTradesPerDay) {
      return result(
        false,
        `${String(tradesToday)} orders have been placed today, which is the configured maximum.`,
      );
    }

    return result(true, null);
  }

  // --------------------------------------------------------------------------

  /**
   * Records fills, positions, lots, fees and cash from a broker order.
   *
   * Idempotent by `brokerExecId`: a fill already stored is skipped, so polling
   * the same order twice cannot double a position. Everything for one fill
   * happens in one transaction, so cash and shares can never disagree.
   */
  private async ingest(
    orderId: string,
    brokerOrder: BrokerOrder,
    principal: Principal | null,
    options: { stopForPosition: string | null; targetForPosition: string | null },
  ): Promise<void> {
    const order = await this.db.order.findUniqueOrThrow({ where: { id: orderId } });

    for (const execution of brokerOrder.executions) {
      const already = await this.db.execution.findUnique({
        where: { brokerExecId: execution.executionId },
      });
      if (already) continue;

      await this.db.$transaction(async (tx) => {
        const stored = await tx.execution.create({
          data: {
            orderId,
            portfolioId: order.portfolioId,
            brokerExecId: execution.executionId,
            symbol: execution.symbol,
            side: execution.side,
            quantity: execution.quantity.toString(),
            price: execution.price.toString(),
            fees: execution.fees.toString(),
            executedAt: execution.executedAt,
            liquidityFlag: execution.liquidityFlag,
          },
        });

        const outcome = await applyFill(tx, {
          portfolioId: order.portfolioId,
          symbol: execution.symbol,
          side: execution.side,
          quantity: execution.quantity,
          price: execution.price,
          fees: execution.fees,
          executedAt: execution.executedAt,
          executionId: stored.id,
          stopPrice: options.stopForPosition ? dec(options.stopForPosition) : null,
          targetPrice: options.targetForPosition ? dec(options.targetForPosition) : null,
        });

        const notional = execution.price.times(execution.quantity);
        const cashDelta =
          execution.side === 'BUY'
            ? notional.plus(execution.fees).negated()
            : notional.minus(execution.fees);

        const portfolio = await tx.portfolio.findUniqueOrThrow({
          where: { id: order.portfolioId },
        });
        await tx.portfolio.update({
          where: { id: order.portfolioId },
          data: {
            cashBalance: dec(portfolio.cashBalance.toString()).plus(cashDelta).toString(),
          },
        });

        if (execution.fees.greaterThan(0)) {
          await tx.fee.create({
            data: {
              portfolioId: order.portfolioId,
              orderId,
              type: 'REGULATORY',
              amount: execution.fees.toString(),
              description: `${execution.symbol} ${execution.side} ${execution.quantity.toString()}`,
              incurredAt: execution.executedAt,
            },
          });
        }

        // A position opening gets a journal entry automatically, with the
        // context that produced it. Asking a person to write one later means
        // it is written after the outcome is known, which is not a thesis.
        if (outcome.opened) {
          await tx.tradeJournalEntry.create({
            data: {
              portfolioId: order.portfolioId,
              positionId: outcome.positionId,
              signalId: order.signalId,
              authorId: principal?.id ?? null,
              entryThesis:
                order.signalId === null
                  ? `Manual ${execution.side} of ${execution.quantity.toString()} ${execution.symbol} at ${execution.price.toString()}.`
                  : `Approved signal: ${execution.side} ${execution.quantity.toString()} ${execution.symbol} at ${execution.price.toString()}.`,
              technicalContext: {
                orderId,
                brokerOrderId: brokerOrder.brokerOrderId,
                expectedPrice: order.expectedPrice?.toString() ?? null,
                fillPrice: execution.price.toString(),
              } as unknown as Prisma.InputJsonValue,
            },
          });
        }
      });
    }

    await this.applyBrokerStatus(orderId, brokerOrder, principal);
  }

  private async applyBrokerStatus(
    orderId: string,
    brokerOrder: BrokerOrder,
    principal: Principal | null,
  ): Promise<void> {
    const order = await this.db.order.findUniqueOrThrow({
      where: { id: orderId },
      include: { executions: true },
    });

    const filledQty = order.executions.reduce(
      (total, execution) => total.plus(dec(execution.quantity.toString())),
      dec(0),
    );
    const feesTotal = order.executions.reduce(
      (total, execution) => total.plus(dec(execution.fees.toString())),
      dec(0),
    );
    const notional = order.executions.reduce(
      (total, execution) =>
        total.plus(dec(execution.price.toString()).times(dec(execution.quantity.toString()))),
      dec(0),
    );
    const averageFillPrice = filledQty.greaterThan(0) ? notional.div(filledQty) : null;

    const expected = order.expectedPrice ? dec(order.expectedPrice.toString()) : null;
    // Slippage is signed against the side: paying more than expected on a buy
    // is adverse, and so is receiving less on a sell.
    const slippage =
      expected && averageFillPrice
        ? order.side === 'BUY'
          ? averageFillPrice.minus(expected)
          : expected.minus(averageFillPrice)
        : null;

    await this.db.order.update({
      where: { id: orderId },
      data: {
        filledQty: filledQty.toString(),
        feesTotal: feesTotal.toString(),
        averageFillPrice: averageFillPrice ? averageFillPrice.toString() : null,
        slippage: slippage ? slippage.toString() : null,
        slippagePct:
          slippage && expected && expected.greaterThan(0)
            ? slippage.div(expected).times(100).toString()
            : null,
        lastSyncedAt: new Date(),
      },
    });

    const target = brokerOrder.status;
    if (target !== order.status) {
      await this.transition(orderId, order.status as OrderStatus, target, principal, {
        reason: `broker reports ${target}`,
        data: {
          ...(target === OrderStatus.FILLED ? { filledAt: brokerOrder.updatedAt } : {}),
          ...(target === OrderStatus.CANCELLED ? { cancelledAt: brokerOrder.updatedAt } : {}),
          ...(brokerOrder.rejectReason ? { rejectionReason: brokerOrder.rejectReason } : {}),
        },
      });
    }

    if (order.signalId) await this.followSignal(order.signalId, target, principal);
  }

  /** Keeps the signal's lifecycle in step with its order's. */
  private async followSignal(
    signalId: string,
    orderStatus: OrderStatus,
    principal: Principal | null,
  ): Promise<void> {
    const signal = await this.db.signal.findUnique({ where: { id: signalId } });
    if (!signal) return;
    const from = signal.status as SignalStatus;

    const next =
      orderStatus === OrderStatus.FILLED
        ? SignalStatus.FILLED
        : orderStatus === OrderStatus.PARTIALLY_FILLED
          ? SignalStatus.PARTIALLY_FILLED
          : orderStatus === OrderStatus.CANCELLED
            ? SignalStatus.CANCELLED
            : orderStatus === OrderStatus.REJECTED
              ? SignalStatus.REJECTED
              : null;
    if (!next || next === from) return;

    await this.moveSignal(signalId, from, next, principal, `order is ${orderStatus}`);

    if (next === SignalStatus.FILLED) {
      await this.moveSignal(
        signalId,
        SignalStatus.FILLED,
        SignalStatus.POSITION_OPEN,
        principal,
        'position opened',
      );
    }
  }

  /** Default size: the version's maximum notional, in whole shares. */
  private async sizeFor(
    signal: {
      symbol: string;
      referencePrice: { toString(): string };
      strategyVersionId: string | null;
    },
    portfolio: { cashBalance: { toString(): string } },
  ): Promise<Decimal> {
    const price = dec(signal.referencePrice.toString());
    if (price.lessThanOrEqualTo(0)) return dec(0);

    let budget = dec(portfolio.cashBalance.toString());
    if (signal.strategyVersionId) {
      const version = await this.db.strategyVersion.findUnique({
        where: { id: signal.strategyVersionId },
        select: { riskSettings: true },
      });
      const settings = version?.riskSettings as { maxNotionalPerTrade?: string } | null;
      if (settings?.maxNotionalPerTrade) {
        budget = Decimal.min(budget, dec(settings.maxNotionalPerTrade));
      }
    }
    return budget.div(price).floor();
  }

  private async moveSignal(
    signalId: string,
    from: SignalStatus,
    to: SignalStatus,
    principal: Principal | null,
    reason: string,
  ): Promise<void> {
    await this.db.$transaction(async (tx) => {
      await tx.signal.update({ where: { id: signalId }, data: { status: to } });
      await tx.signalEvent.create({
        data: {
          signalId,
          fromStatus: from,
          toStatus: to,
          reason,
          actor: principal ? principal.email : 'system',
        },
      });
    });
  }

  private async transition(
    orderId: string,
    from: OrderStatus,
    to: OrderStatus,
    principal: Principal | null,
    options: { reason: string; data?: Record<string, unknown> },
  ): Promise<void> {
    // The shared machine decides. A status this module cannot justify is one
    // it cannot write.
    assertOrderTransition(from, to);
    await this.db.order.update({
      where: { id: orderId },
      data: { status: to, ...(options.data as Prisma.OrderUpdateInput) },
    });
    await this.recordEvent(orderId, from, to, principal, options.reason);
  }

  private async recordEvent(
    orderId: string,
    from: OrderStatus | null,
    to: OrderStatus,
    principal: Principal | null,
    reason: string,
  ): Promise<void> {
    await this.db.orderEvent.create({
      data: {
        orderId,
        fromStatus: from,
        toStatus: to,
        reason,
        actor: principal ? principal.email : 'system',
      },
    });
  }

  private async viewOf(orderId: string): Promise<OrderView> {
    const row = await this.db.order.findUniqueOrThrow({
      where: { id: orderId },
      include: { executions: { orderBy: { executedAt: 'asc' } } },
    });
    return toView(row);
  }
}

function startOfUtcDay(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

interface OrderRow {
  id: string;
  idempotencyKey: string;
  correlationId: string;
  portfolioId: string;
  signalId: string | null;
  symbol: string;
  side: string;
  orderType: string;
  timeInForce: string;
  status: string;
  environment: string;
  requestedQty: { toString(): string };
  filledQty: { toString(): string };
  limitPrice: { toString(): string } | null;
  stopPrice: { toString(): string } | null;
  averageFillPrice: { toString(): string } | null;
  expectedPrice: { toString(): string } | null;
  slippage: { toString(): string } | null;
  feesTotal: { toString(): string };
  rejectionReason: string | null;
  brokerOrderId: string | null;
  submittedAt: Date | null;
  filledAt: Date | null;
  createdAt: Date;
  executions: {
    id: string;
    quantity: { toString(): string };
    price: { toString(): string };
    fees: { toString(): string };
    executedAt: Date;
  }[];
}

function toView(row: OrderRow): OrderView {
  return {
    id: row.id,
    idempotencyKey: row.idempotencyKey,
    correlationId: row.correlationId,
    portfolioId: row.portfolioId,
    signalId: row.signalId,
    symbol: row.symbol,
    side: row.side,
    orderType: row.orderType,
    timeInForce: row.timeInForce,
    status: row.status,
    environment: row.environment,
    requestedQty: row.requestedQty.toString(),
    filledQty: row.filledQty.toString(),
    limitPrice: row.limitPrice ? row.limitPrice.toString() : null,
    stopPrice: row.stopPrice ? row.stopPrice.toString() : null,
    averageFillPrice: row.averageFillPrice ? row.averageFillPrice.toString() : null,
    expectedPrice: row.expectedPrice ? row.expectedPrice.toString() : null,
    slippage: row.slippage ? row.slippage.toString() : null,
    feesTotal: row.feesTotal.toString(),
    rejectionReason: row.rejectionReason,
    brokerOrderId: row.brokerOrderId,
    submittedAt: row.submittedAt,
    filledAt: row.filledAt,
    createdAt: row.createdAt,
    executions: row.executions.map((execution) => ({
      id: execution.id,
      quantity: execution.quantity.toString(),
      price: execution.price.toString(),
      fees: execution.fees.toString(),
      executedAt: execution.executedAt,
    })),
  };
}
