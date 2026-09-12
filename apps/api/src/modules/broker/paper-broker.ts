import { randomUUID } from 'node:crypto';
import {
  AssetClass,
  Decimal,
  MarketSession,
  OrderStatus,
  OrderType,
  TimeInForce,
  TradingEnvironment,
  assertOrderTransition,
  dec,
  isTerminalOrderStatus,
  roundMoney,
  roundQuantity,
} from '@zusu/shared';
import { BrokerError, type BrokerAdapter, type BrokerAccountSnapshot } from './types.js';
import type {
  BrokerExecution,
  BrokerHealth,
  BrokerOrder,
  BrokerPosition,
  BrokerQuote,
  OptionsChain,
  PlaceOrderRequest,
} from './types.js';

/**
 * The paper broker (§35).
 *
 * The difference from the demo broker is the price source: this one matches
 * against *stored market bars* — the same candles the charts and the backtest
 * read — rather than a simulator's own path. That is what makes paper results
 * comparable with live ones: the prices are the market's, and only the
 * execution is imagined.
 *
 * Four rules, and the first is the one that makes the whole thing worth
 * running:
 *
 *   1. **An order can only fill from a bar that opened after it was
 *      submitted.** A fill priced from the bar the decision was made on would
 *      be the same look-ahead the backtest engine refuses, except live and
 *      therefore invisible. Latency is added on top: the venue acknowledges
 *      after `ackLatencyMs` and is not matchable before that.
 *
 *   2. **Liquidity is finite.** A single bar fills at most a participation
 *      fraction of its own volume, so a large order fills across several bars
 *      and a thin symbol fills slowly. An order that always fills in full is
 *      the most flattering lie a paper account can tell.
 *
 *   3. **A stop that gaps fills at the open.** Identical to the backtest rule,
 *      and for the same reason: claiming the stop price through a gap invents
 *      liquidity that was never there.
 *
 *   4. **Fills are priced across the spread, then slipped.** A buy pays the
 *      ask and a sell receives the bid, with an extra adverse move that grows
 *      with the share of the bar's volume taken.
 *
 * State lives in this process, like the demo broker's, so it is the *broker's*
 * truth and deliberately separate from the application database — which is
 * what gives reconciliation two independent sources to compare.
 */

const PROVIDER = 'paper-venue';

/** Venue acknowledgement latency before an order is matchable. */
const ACK_LATENCY_MS = 400;
/** The most of one bar's volume a single order may take. */
const PARTICIPATION_FRACTION = 0.05;
/** Half-spread applied when the stored bar carries no quote of its own. */
const ASSUMED_HALF_SPREAD = 0.0002;
/** Slippage at full participation, scaled down linearly for smaller orders. */
const MAX_SLIPPAGE_FRACTION = 0.0015;

const SEC_FEE_RATE = 0.0000278;
const TAF_PER_SHARE = 0.000166;
const TAF_CAP = 8.3;

/** One bar of the market, as the paper venue sees it. */
export interface PaperBar {
  openTime: Date;
  open: Decimal;
  high: Decimal;
  low: Decimal;
  close: Decimal;
  volume: Decimal;
}

/**
 * Where the venue gets its prices.
 *
 * An interface rather than a database call so the broker stays testable and
 * so the same venue can be driven by stored candles, a live feed, or a fixture
 * without knowing the difference.
 */
export interface PaperPriceSource {
  /** Bars for a symbol that opened at or after `since`, ascending. */
  barsSince(symbol: string, since: Date): Promise<PaperBar[]>;
  /** The newest stored bar, for marking positions and quoting. */
  latestBar(symbol: string): Promise<PaperBar | null>;
}

interface PaperOrderState extends BrokerOrder {
  /** The instant from which this order may consider a bar. */
  matchableFrom: Date;
  /** The last bar already applied, so a poll never double-fills. */
  matchedUpTo: Date;
  triggered: boolean;
  expectedPrice: Decimal | null;
}

interface PaperPositionState {
  symbol: string;
  quantity: Decimal;
  averageEntryPrice: Decimal;
  realizedPnl: Decimal;
  openedAt: Date;
}

export interface PaperBrokerOptions {
  accountId?: string;
  startingCash?: Decimal | number | string;
  prices: PaperPriceSource;
  now?: () => number;
}

export class PaperBroker implements BrokerAdapter {
  readonly kind = 'PAPER' as const;
  readonly environment = TradingEnvironment.PAPER;

  private readonly accountId: string;
  private readonly prices: PaperPriceSource;
  private readonly now: () => number;

  private cash: Decimal;
  private readonly orders = new Map<string, PaperOrderState>();
  /** Idempotency: a client order id maps to the order it created, forever. */
  private readonly byClientOrderId = new Map<string, string>();
  private readonly positions = new Map<string, PaperPositionState>();
  /** Every fill, for the caller to persist as a paper trade. */
  private readonly fills: (BrokerExecution & { slippage: Decimal; spreadCost: Decimal })[] = [];

  constructor(options: PaperBrokerOptions) {
    this.accountId = options.accountId ?? `PAPER-${randomUUID().slice(0, 8)}`;
    this.prices = options.prices;
    this.now = options.now ?? (() => Date.now());
    this.cash = dec(options.startingCash ?? 100_000);
  }

  async getAccount(): Promise<BrokerAccountSnapshot> {
    let positionsValue = dec(0);
    for (const position of this.positions.values()) {
      const bar = await this.prices.latestBar(position.symbol);
      if (!bar) continue;
      positionsValue = positionsValue.plus(bar.close.times(position.quantity));
    }

    return {
      accountId: this.accountId,
      environment: this.environment,
      currency: 'USD',
      cash: roundMoney(this.cash),
      // No margin in paper: cash is the buying power, which keeps a paper
      // result comparable with a cash account rather than a leveraged one.
      buyingPower: roundMoney(this.cash),
      equity: roundMoney(this.cash.plus(positionsValue)),
      maintenanceMargin: dec(0),
      isPatternDayTrader: false,
      updatedAt: new Date(this.now()),
    };
  }

  async getPositions(): Promise<BrokerPosition[]> {
    const result: BrokerPosition[] = [];
    for (const position of this.positions.values()) {
      if (position.quantity.isZero()) continue;
      const bar = await this.prices.latestBar(position.symbol);
      const mark = bar?.close ?? position.averageEntryPrice;
      result.push({
        symbol: position.symbol,
        assetClass: AssetClass.EQUITY,
        quantity: position.quantity,
        averageEntryPrice: roundMoney(position.averageEntryPrice),
        markPrice: roundMoney(mark),
        marketValue: roundMoney(mark.times(position.quantity)),
        unrealizedPnl: roundMoney(mark.minus(position.averageEntryPrice).times(position.quantity)),
        updatedAt: new Date(this.now()),
      });
    }
    return result;
  }

  async getOrders(filter: { openOnly?: boolean; since?: Date } = {}): Promise<BrokerOrder[]> {
    const orders: BrokerOrder[] = [];
    for (const order of this.orders.values()) {
      await this.settle(order);
      if (filter.openOnly && isTerminalOrderStatus(order.status)) continue;
      if (filter.since && order.submittedAt < filter.since) continue;
      orders.push(this.toPublic(order));
    }
    return orders.sort((a, b) => b.submittedAt.getTime() - a.submittedAt.getTime());
  }

  async getQuote(symbol: string): Promise<BrokerQuote> {
    const bar = await this.prices.latestBar(symbol);
    if (!bar) {
      throw new BrokerError(`No stored bar for ${symbol}, so the venue cannot quote it`, false);
    }

    const half = bar.close.times(dec(ASSUMED_HALF_SPREAD));
    const received = new Date(this.now());
    return {
      symbol,
      provider: PROVIDER,
      price: roundMoney(bar.close),
      bid: roundMoney(bar.close.minus(half)),
      ask: roundMoney(bar.close.plus(half)),
      // Depth is modelled from the bar's own volume rather than invented: a
      // thin bar quotes thin size, which is what limits a fill.
      bidSize: roundQuantity(bar.volume.times(dec(PARTICIPATION_FRACTION))),
      askSize: roundQuantity(bar.volume.times(dec(PARTICIPATION_FRACTION))),
      volume: bar.volume,
      sourceTimestamp: bar.openTime,
      receivedTimestamp: received,
      marketSession: MarketSession.REGULAR,
    };
  }

  async placeOrder(request: PlaceOrderRequest): Promise<BrokerOrder> {
    const existingId = this.byClientOrderId.get(request.idempotencyKey);
    if (existingId) {
      const existing = this.orders.get(existingId);
      if (existing) {
        // Re-submitting a key returns the order it already created. A second
        // order would be a duplicate position nobody asked for.
        await this.settle(existing);
        return this.toPublic(existing);
      }
    }

    if (request.quantity.lessThanOrEqualTo(0)) {
      throw new BrokerError('Quantity must be positive', false);
    }
    if (request.assetClass !== AssetClass.EQUITY) {
      throw new BrokerError('The paper venue trades equities only', false);
    }
    if (
      (request.orderType === OrderType.LIMIT || request.orderType === OrderType.STOP_LIMIT) &&
      !request.limitPrice
    ) {
      throw new BrokerError('A limit order needs a limit price', false);
    }
    if (
      (request.orderType === OrderType.STOP || request.orderType === OrderType.STOP_LIMIT) &&
      !request.stopPrice
    ) {
      throw new BrokerError('A stop order needs a stop price', false);
    }

    const submittedAt = new Date(this.now());
    const order: PaperOrderState = {
      brokerOrderId: randomUUID(),
      clientOrderId: request.idempotencyKey,
      symbol: request.symbol,
      assetClass: request.assetClass,
      side: request.side,
      orderType: request.orderType,
      timeInForce: request.timeInForce,
      status: OrderStatus.SUBMITTED,
      requestedQty: request.quantity,
      filledQty: dec(0),
      averageFillPrice: null,
      limitPrice: request.limitPrice ?? null,
      stopPrice: request.stopPrice ?? null,
      fees: dec(0),
      rejectReason: null,
      submittedAt,
      updatedAt: submittedAt,
      executions: [],
      // The bar the decision was made on is already in the past: an order may
      // only see bars that opened after it arrived, plus the venue's latency.
      matchableFrom: new Date(submittedAt.getTime() + ACK_LATENCY_MS),
      matchedUpTo: submittedAt,
      triggered: request.orderType !== OrderType.STOP && request.orderType !== OrderType.STOP_LIMIT,
      expectedPrice: request.expectedPrice ?? null,
    };

    this.orders.set(order.brokerOrderId, order);
    this.byClientOrderId.set(request.idempotencyKey, order.brokerOrderId);

    this.transition(order, OrderStatus.ACKNOWLEDGED, 'acknowledged by the paper venue');
    await this.settle(order);
    return this.toPublic(order);
  }

  async cancelOrder(brokerOrderId: string): Promise<BrokerOrder> {
    const order = this.orders.get(brokerOrderId);
    if (!order) throw new BrokerError(`Unknown order ${brokerOrderId}`, false);

    // Settle first: a fill that already happened cannot be cancelled away,
    // which is exactly the race a real venue has.
    await this.settle(order);
    if (isTerminalOrderStatus(order.status)) {
      throw new BrokerError(
        `Order ${brokerOrderId} is already ${order.status} and cannot be cancelled`,
        false,
      );
    }

    this.transition(
      order,
      order.filledQty.greaterThan(0) ? OrderStatus.PARTIALLY_FILLED : OrderStatus.CANCELLED,
      'cancelled by the client',
    );
    if (order.filledQty.greaterThan(0)) {
      this.transition(order, OrderStatus.CANCELLED, 'cancelled after a partial fill');
    }
    return this.toPublic(order);
  }

  async getOrderStatus(brokerOrderId: string): Promise<BrokerOrder> {
    const order = this.orders.get(brokerOrderId);
    if (!order) throw new BrokerError(`Unknown order ${brokerOrderId}`, false);
    await this.settle(order);
    return this.toPublic(order);
  }

  getOptionsChain(): Promise<OptionsChain> {
    return Promise.reject(
      new BrokerError('The paper venue does not price options; that arrives with Phase 8', false),
    );
  }

  healthCheck(): Promise<BrokerHealth> {
    return Promise.resolve({
      ok: true,
      latencyMs: ACK_LATENCY_MS,
      detail: 'paper venue, priced from stored market bars',
      checkedAt: new Date(this.now()),
    });
  }

  /** Fills recorded since the last drain, for the caller to persist. */
  drainFills(): (BrokerExecution & { slippage: Decimal; spreadCost: Decimal })[] {
    return this.fills.splice(0, this.fills.length);
  }

  // --------------------------------------------------------------------------

  /**
   * Applies every bar that has appeared since this order was last matched.
   *
   * Pull-based rather than a timer: the venue's state advances when somebody
   * asks about it, which keeps it deterministic and testable. A real venue
   * pushes, and the adapter for one will.
   */
  private async settle(order: PaperOrderState): Promise<void> {
    if (isTerminalOrderStatus(order.status)) return;

    const from = new Date(Math.max(order.matchableFrom.getTime(), order.matchedUpTo.getTime()));
    const bars = await this.prices.barsSince(order.symbol, from);

    for (const bar of bars) {
      if (bar.openTime.getTime() > this.now()) break;
      if (bar.openTime <= order.matchedUpTo) continue;
      order.matchedUpTo = bar.openTime;

      if (!order.triggered) {
        if (!this.stopTriggered(order, bar)) continue;
        order.triggered = true;
      }

      const price = this.fillPriceFor(order, bar);
      if (!price) continue;

      const remaining = order.requestedQty.minus(order.filledQty);
      if (remaining.lessThanOrEqualTo(0)) break;

      // Liquidity: a bar can only give up a fraction of its own volume.
      const available = roundQuantity(bar.volume.times(dec(PARTICIPATION_FRACTION)));
      const quantity = Decimal.min(remaining, available.greaterThan(0) ? available : remaining);
      if (quantity.lessThanOrEqualTo(0)) continue;

      this.applyFill(order, quantity, price.price, bar, price.participation);

      if (order.filledQty.greaterThanOrEqualTo(order.requestedQty)) {
        this.transition(order, OrderStatus.FILLED, 'fully filled');
        return;
      }
      this.transition(order, OrderStatus.PARTIALLY_FILLED, 'partially filled');
    }

    // A day order that saw the session out without filling expires rather than
    // resting forever.
    if (
      order.timeInForce === TimeInForce.DAY &&
      !isTerminalOrderStatus(order.status) &&
      this.now() - order.submittedAt.getTime() > 86_400_000
    ) {
      this.transition(order, OrderStatus.EXPIRED, 'day order expired unfilled');
    }
  }

  private stopTriggered(order: PaperOrderState, bar: PaperBar): boolean {
    const stop = order.stopPrice;
    if (!stop) return true;
    return order.side === 'BUY'
      ? bar.high.greaterThanOrEqualTo(stop)
      : bar.low.lessThanOrEqualTo(stop);
  }

  /**
   * The price this bar would fill at, or null if it would not fill.
   *
   * Returns the participation share as well, because slippage grows with it.
   */
  private fillPriceFor(
    order: PaperOrderState,
    bar: PaperBar,
  ): { price: Decimal; participation: Decimal } | null {
    const remaining = order.requestedQty.minus(order.filledQty);
    const capacity = bar.volume.times(dec(PARTICIPATION_FRACTION));
    const participation = capacity.greaterThan(0)
      ? Decimal.min(dec(1), remaining.div(capacity))
      : dec(1);

    const buy = order.side === 'BUY';

    if (order.orderType === OrderType.MARKET || order.orderType === OrderType.STOP) {
      // A stop becomes a market order when it triggers — and a bar that opened
      // through the stop fills at that open, which is the worse price.
      const reference =
        order.orderType === OrderType.STOP && order.stopPrice
          ? gappedThrough(order.side, bar.open, order.stopPrice)
            ? bar.open
            : order.stopPrice
          : bar.open;
      return { price: this.acrossSpread(reference, buy, participation), participation };
    }

    const limit = order.limitPrice;
    if (!limit) return null;

    // A limit fills only if the bar actually traded at or through it.
    const traded = buy ? bar.low.lessThanOrEqualTo(limit) : bar.high.greaterThanOrEqualTo(limit);
    if (!traded) return null;

    // A bar that opened past the limit fills at the open — better than the
    // limit, which is what a real venue would give.
    const opened = buy ? bar.open.lessThan(limit) : bar.open.greaterThan(limit);
    const reference = opened ? bar.open : limit;
    return { price: this.acrossSpread(reference, buy, participation), participation };
  }

  private acrossSpread(reference: Decimal, buy: boolean, participation: Decimal): Decimal {
    const half = dec(ASSUMED_HALF_SPREAD);
    const slip = dec(MAX_SLIPPAGE_FRACTION).times(participation);
    const drag = half.plus(slip);
    return roundMoney(
      buy ? reference.times(dec(1).plus(drag)) : reference.times(dec(1).minus(drag)),
    );
  }

  private applyFill(
    order: PaperOrderState,
    quantity: Decimal,
    price: Decimal,
    bar: PaperBar,
    participation: Decimal,
  ): void {
    const buy = order.side === 'BUY';
    const notional = price.times(quantity);
    const fees = this.feesFor(order.side, quantity, notional);

    const spreadCost = bar.close.times(dec(ASSUMED_HALF_SPREAD)).times(quantity);
    const slippage = bar.close
      .times(dec(MAX_SLIPPAGE_FRACTION).times(participation))
      .times(quantity);

    const execution: BrokerExecution & { slippage: Decimal; spreadCost: Decimal } = {
      executionId: randomUUID(),
      brokerOrderId: order.brokerOrderId,
      symbol: order.symbol,
      side: order.side,
      quantity: roundQuantity(quantity),
      price: roundMoney(price),
      fees: roundMoney(fees),
      executedAt: bar.openTime,
      // A paper order always takes liquidity: it is not resting in a book
      // anybody else can trade against.
      liquidityFlag: 'REMOVED',
      slippage: roundMoney(slippage),
      spreadCost: roundMoney(spreadCost),
    };

    order.executions.push(execution);
    this.fills.push(execution);

    const filled = order.filledQty.plus(quantity);
    const previousNotional = (order.averageFillPrice ?? dec(0)).times(order.filledQty);
    order.averageFillPrice = roundMoney(previousNotional.plus(notional).div(filled));
    order.filledQty = roundQuantity(filled);
    order.fees = roundMoney(order.fees.plus(fees));
    order.updatedAt = bar.openTime;

    this.cash = buy ? this.cash.minus(notional).minus(fees) : this.cash.plus(notional).minus(fees);

    this.applyToPosition(order.symbol, buy ? quantity : quantity.negated(), price, bar.openTime);
  }

  private applyToPosition(symbol: string, signedQuantity: Decimal, price: Decimal, at: Date): void {
    const existing = this.positions.get(symbol);
    if (!existing) {
      this.positions.set(symbol, {
        symbol,
        quantity: signedQuantity,
        averageEntryPrice: price,
        realizedPnl: dec(0),
        openedAt: at,
      });
      return;
    }

    const sameDirection = existing.quantity.isPositive() === signedQuantity.isPositive();
    if (sameDirection || existing.quantity.isZero()) {
      const total = existing.quantity.plus(signedQuantity);
      const cost = existing.averageEntryPrice
        .times(existing.quantity)
        .plus(price.times(signedQuantity));
      existing.averageEntryPrice = total.isZero() ? price : cost.div(total);
      existing.quantity = total;
      return;
    }

    // Reducing or reversing: the part that closes realises against the average
    // entry, and anything beyond it opens a new position at the fill price.
    const wasLong = existing.quantity.isPositive();
    const closing = Decimal.min(existing.quantity.abs(), signedQuantity.abs());
    existing.realizedPnl = existing.realizedPnl.plus(
      price
        .minus(existing.averageEntryPrice)
        .times(closing)
        .times(wasLong ? dec(1) : dec(-1)),
    );

    const remaining = existing.quantity.plus(signedQuantity);
    if (remaining.isZero()) {
      this.positions.delete(symbol);
      return;
    }
    // A reversal is a new position: its cost basis is the fill that opened it,
    // not the average of a position that no longer exists.
    if (remaining.isPositive() !== wasLong) existing.averageEntryPrice = price;
    existing.quantity = remaining;
  }

  private feesFor(side: string, quantity: Decimal, notional: Decimal): Decimal {
    // Sell-side regulatory fees only, as on a US equity venue.
    if (side !== 'SELL') return dec(0);
    const sec = notional.times(dec(SEC_FEE_RATE));
    const taf = Decimal.min(quantity.times(dec(TAF_PER_SHARE)), dec(TAF_CAP));
    return sec.plus(taf);
  }

  private transition(order: PaperOrderState, to: OrderStatus, reason: string): void {
    if (order.status === to) return;
    // The shared state machine decides what is legal, so the paper venue
    // cannot invent a transition the rest of the platform would refuse.
    assertOrderTransition(order.status, to);
    order.status = to;
    order.rejectReason = to === OrderStatus.REJECTED ? reason : order.rejectReason;
    order.updatedAt = new Date(this.now());
  }

  private toPublic(order: PaperOrderState): BrokerOrder {
    return {
      brokerOrderId: order.brokerOrderId,
      clientOrderId: order.clientOrderId,
      symbol: order.symbol,
      assetClass: order.assetClass,
      side: order.side,
      orderType: order.orderType,
      timeInForce: order.timeInForce,
      status: order.status,
      requestedQty: order.requestedQty,
      filledQty: order.filledQty,
      averageFillPrice: order.averageFillPrice,
      limitPrice: order.limitPrice,
      stopPrice: order.stopPrice,
      fees: order.fees,
      rejectReason: order.rejectReason,
      submittedAt: order.submittedAt,
      updatedAt: order.updatedAt,
      executions: order.executions.map((execution) => ({ ...execution })),
    };
  }
}

/** True when a bar's open is already past the stop, in the adverse direction. */
function gappedThrough(side: string, open: Decimal, stop: Decimal): boolean {
  return side === 'BUY' ? open.greaterThan(stop) : open.lessThan(stop);
}
