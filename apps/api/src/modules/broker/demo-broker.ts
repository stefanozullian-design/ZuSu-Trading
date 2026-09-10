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
import { blackScholes } from './black-scholes.js';
import { MarketSimulator } from './market-simulator.js';
import {
  BrokerError,
  type BrokerAccountSnapshot,
  type BrokerAdapter,
  type BrokerExecution,
  type BrokerHealth,
  type BrokerOrder,
  type BrokerPosition,
  type BrokerQuote,
  type OptionsChain,
  type PlaceOrderRequest,
} from './types.js';

const PROVIDER = 'demo-simulator';

/** Time the venue takes to acknowledge an order. */
const ACK_LATENCY_MS = 150;
/** Granularity at which the simulated venue matches resting quantity. */
const MATCH_SLICE_MS = 1_000;
/** Safety bound so a long-idle order cannot spin through days of slices. */
const MAX_SLICES_PER_SETTLE = 900;

/** Regulatory fees, modelled so downstream fee plumbing is exercised (§29). */
const SEC_FEE_RATE = 0.0000278;
const TAF_PER_SHARE = 0.000166;
const TAF_CAP = 8.3;

interface DemoOrderState extends BrokerOrder {
  /** Simulated-clock position of the matcher for this order. */
  matchedUpToMs: number;
  triggered: boolean;
}

interface DemoPositionState {
  symbol: string;
  quantity: Decimal;
  averageEntryPrice: Decimal;
  realizedPnl: Decimal;
  openedAt: Date;
}

export interface DemoBrokerOptions {
  accountId?: string;
  startingCash?: Decimal | number | string;
  seed?: number;
  now?: () => number;
  simulator?: MarketSimulator;
}

/**
 * A self-contained simulated venue for the DEMO environment.
 *
 * It is a real implementation of `BrokerAdapter`, not a stub that returns
 * success: orders are acknowledged after a latency, matched against a
 * deterministic price path, fill partially when they exceed available
 * liquidity, cost regulatory fees, move cash and build positions. Its state is
 * the *broker's* truth and is deliberately separate from the application
 * database, so reconciliation has two independent sources to compare (§26).
 *
 * State lives in the process and is lost on restart — acceptable for a
 * simulator, and documented in BUILD_STATUS.md.
 */
export class DemoBroker implements BrokerAdapter {
  readonly kind = 'DEMO' as const;
  readonly environment: TradingEnvironment = TradingEnvironment.DEMO;

  private readonly accountId: string;
  private readonly simulator: MarketSimulator;
  private readonly now: () => number;
  private readonly orders = new Map<string, DemoOrderState>();
  private readonly ordersByIdempotencyKey = new Map<string, string>();
  private readonly positions = new Map<string, DemoPositionState>();
  private cash: Decimal;
  private readonly startingCash: Decimal;

  constructor(options: DemoBrokerOptions = {}) {
    this.accountId = options.accountId ?? 'DEMO-ACCOUNT-1';
    this.now = options.now ?? (() => Date.now());
    this.simulator =
      options.simulator ?? new MarketSimulator({ seed: options.seed, now: this.now });
    this.startingCash = roundMoney(dec(options.startingCash ?? 100_000));
    this.cash = this.startingCash;
  }

  // -------------------------------------------------------------------------
  // Market data
  // -------------------------------------------------------------------------

  async getQuote(symbol: string): Promise<BrokerQuote> {
    const upper = symbol.toUpperCase();
    const at = this.now();
    const mid = this.simulator.priceAt(upper, at);
    const halfSpread = this.simulator.spreadAt(upper, at).dividedBy(2);
    const received = new Date(at);
    return {
      symbol: upper,
      provider: PROVIDER,
      price: mid,
      bid: mid.minus(halfSpread).toDecimalPlaces(4, Decimal.ROUND_DOWN),
      ask: mid.plus(halfSpread).toDecimalPlaces(4, Decimal.ROUND_UP),
      bidSize: this.simulator.liquidityPerSecond(upper),
      askSize: this.simulator.liquidityPerSecond(upper),
      volume: this.simulator.volumeAt(upper, at),
      // The simulator has no upstream feed, so both stamps are the same instant.
      sourceTimestamp: received,
      receivedTimestamp: received,
      marketSession: this.simulator.sessionAt(received),
    };
  }

  async getOptionsChain(
    symbol: string,
    options: { expiration?: Date } = {},
  ): Promise<OptionsChain> {
    const upper = symbol.toUpperCase();
    const at = this.now();
    const spot = this.simulator.priceAt(upper, at);
    const instrument = this.simulator.instrument(upper);
    const expiration = options.expiration ?? nextFriday(new Date(at));
    const years = Math.max((expiration.getTime() - at) / (365 * 24 * 3600 * 1000), 1 / 365);
    const spotNum = spot.toNumber();
    const step = Math.max(1, Math.round(spotNum * 0.025));
    const atm = Math.round(spotNum / step) * step;

    const contracts = [];
    for (let i = -6; i <= 6; i += 1) {
      const strike = atm + i * step;
      if (strike <= 0) continue;
      for (const isCall of [true, false]) {
        // A simple smile: wings priced above the at-the-money vol.
        const moneyness = Math.abs(Math.log(strike / spotNum));
        const iv = instrument.volatility * (1 + 1.6 * moneyness);
        const greeks = blackScholes({
          spot: spotNum,
          strike,
          timeToExpiry: years,
          volatility: iv,
          riskFreeRate: 0.04,
          isCall,
        });
        const mid = Math.max(greeks.price, 0.01);
        const spreadPct = Math.min(0.25, 0.01 + moneyness * 0.6);
        const half = (mid * spreadPct) / 2;
        contracts.push({
          occSymbol: occSymbol(upper, expiration, isCall, strike),
          underlying: upper,
          expiration,
          strike: dec(strike),
          isCall,
          bid: roundMoney(Math.max(0.01, mid - half)),
          ask: roundMoney(mid + half),
          midpoint: roundMoney(mid),
          spreadPct: dec(spreadPct * 100).toDecimalPlaces(4),
          openInterest: Math.round(5_000 * Math.exp(-8 * moneyness)) + 25,
          volume: Math.round(900 * Math.exp(-10 * moneyness)) + 5,
          impliedVolatility: dec(iv).toDecimalPlaces(6),
          delta: dec(greeks.delta).toDecimalPlaces(6),
          gamma: dec(greeks.gamma).toDecimalPlaces(6),
          theta: dec(greeks.theta).toDecimalPlaces(6),
          vega: dec(greeks.vega).toDecimalPlaces(6),
        });
      }
    }
    return { underlying: upper, asOf: new Date(at), contracts };
  }

  // -------------------------------------------------------------------------
  // Account
  // -------------------------------------------------------------------------

  async getAccount(): Promise<BrokerAccountSnapshot> {
    this.settleAll();
    const positionsValue = [...this.positions.values()].reduce(
      (sum, p) => sum.plus(p.quantity.times(this.simulator.priceAt(p.symbol, this.now()))),
      dec(0),
    );
    const equity = roundMoney(this.cash.plus(positionsValue));
    return {
      accountId: this.accountId,
      environment: this.environment,
      currency: 'USD',
      cash: roundMoney(this.cash),
      // The demo account is cash-only: no margin, so buying power is cash.
      buyingPower: roundMoney(this.cash),
      equity,
      maintenanceMargin: dec(0),
      isPatternDayTrader: false,
      updatedAt: new Date(this.now()),
    };
  }

  async getPositions(): Promise<BrokerPosition[]> {
    this.settleAll();
    const at = this.now();
    return [...this.positions.values()]
      .filter((p) => !p.quantity.isZero())
      .map((p) => {
        const mark = this.simulator.priceAt(p.symbol, at);
        return {
          symbol: p.symbol,
          assetClass: AssetClass.EQUITY,
          quantity: p.quantity,
          averageEntryPrice: p.averageEntryPrice,
          markPrice: mark,
          marketValue: roundMoney(p.quantity.times(mark)),
          unrealizedPnl: roundMoney(mark.minus(p.averageEntryPrice).times(p.quantity)),
          updatedAt: new Date(at),
        };
      });
  }

  // -------------------------------------------------------------------------
  // Orders
  // -------------------------------------------------------------------------

  async placeOrder(request: PlaceOrderRequest): Promise<BrokerOrder> {
    if (!request.idempotencyKey) {
      throw new BrokerError('An idempotency key is required for every order', false);
    }

    // Idempotency: the same key always resolves to the same order, however many
    // times a crashed caller retries (§25).
    const existingId = this.ordersByIdempotencyKey.get(request.idempotencyKey);
    if (existingId) {
      return this.snapshot(this.settle(this.mustGet(existingId)));
    }

    if (request.quantity.lte(0)) {
      throw new BrokerError('Order quantity must be greater than zero', false);
    }
    if (
      (request.orderType === OrderType.LIMIT || request.orderType === OrderType.STOP_LIMIT) &&
      !request.limitPrice
    ) {
      throw new BrokerError(`${request.orderType} orders require a limit price`, false);
    }
    if (
      (request.orderType === OrderType.STOP || request.orderType === OrderType.STOP_LIMIT) &&
      !request.stopPrice
    ) {
      throw new BrokerError(`${request.orderType} orders require a stop price`, false);
    }

    const submittedAt = new Date(this.now());
    const symbol = request.symbol.toUpperCase();
    const order: DemoOrderState = {
      brokerOrderId: `demo-${randomUUID()}`,
      clientOrderId: request.idempotencyKey,
      symbol,
      assetClass: request.assetClass,
      side: request.side,
      orderType: request.orderType,
      timeInForce: request.timeInForce,
      status: OrderStatus.SUBMITTED,
      requestedQty: roundQuantity(request.quantity),
      filledQty: dec(0),
      averageFillPrice: null,
      limitPrice: request.limitPrice ?? null,
      stopPrice: request.stopPrice ?? null,
      fees: dec(0),
      rejectReason: null,
      submittedAt,
      updatedAt: submittedAt,
      executions: [],
      matchedUpToMs: submittedAt.getTime() + ACK_LATENCY_MS,
      triggered: request.orderType !== OrderType.STOP && request.orderType !== OrderType.STOP_LIMIT,
    };

    const rejection = this.preTradeReject(order);
    if (rejection) {
      order.status = OrderStatus.REJECTED;
      order.rejectReason = rejection;
    }

    this.orders.set(order.brokerOrderId, order);
    this.ordersByIdempotencyKey.set(request.idempotencyKey, order.brokerOrderId);
    return this.snapshot(this.settle(order));
  }

  async getOrderStatus(brokerOrderId: string): Promise<BrokerOrder> {
    return this.snapshot(this.settle(this.mustGet(brokerOrderId)));
  }

  async getOrders(filter: { openOnly?: boolean; since?: Date } = {}): Promise<BrokerOrder[]> {
    this.settleAll();
    return [...this.orders.values()]
      .filter((o) => (filter.openOnly ? !isTerminalOrderStatus(o.status) : true))
      .filter((o) => (filter.since ? o.submittedAt >= filter.since : true))
      .sort((a, b) => a.submittedAt.getTime() - b.submittedAt.getTime())
      .map((o) => this.snapshot(o));
  }

  async cancelOrder(brokerOrderId: string): Promise<BrokerOrder> {
    const order = this.settle(this.mustGet(brokerOrderId));
    if (isTerminalOrderStatus(order.status)) {
      // Losing the race with a fill is a normal outcome, not an error — the
      // caller is told the real state rather than a fabricated cancellation.
      return this.snapshot(order);
    }
    this.transition(order, OrderStatus.CANCEL_REQUESTED);
    this.transition(order, OrderStatus.CANCELLED);
    order.updatedAt = new Date(this.now());
    return this.snapshot(order);
  }

  async healthCheck(): Promise<BrokerHealth> {
    return {
      ok: true,
      latencyMs: 0,
      detail: 'simulated venue',
      checkedAt: new Date(this.now()),
    };
  }

  // -------------------------------------------------------------------------
  // Matching engine
  // -------------------------------------------------------------------------

  private settleAll(): void {
    for (const order of this.orders.values()) this.settle(order);
  }

  private settle(order: DemoOrderState): DemoOrderState {
    if (isTerminalOrderStatus(order.status)) return order;

    const now = this.now();
    if (now < order.submittedAt.getTime() + ACK_LATENCY_MS) return order;

    if (order.status === OrderStatus.SUBMITTED) {
      this.transition(order, OrderStatus.ACKNOWLEDGED);
    }

    let slices = 0;
    while (order.matchedUpToMs <= now && slices < MAX_SLICES_PER_SETTLE) {
      slices += 1;
      const at = order.matchedUpToMs;
      order.matchedUpToMs += MATCH_SLICE_MS;

      const session = this.simulator.sessionAt(new Date(at));
      if (session === MarketSession.CLOSED || session === MarketSession.HALTED) continue;

      const mid = this.simulator.priceAt(order.symbol, at);
      const half = this.simulator.spreadAt(order.symbol, at).dividedBy(2);
      const bid = mid.minus(half);
      const ask = mid.plus(half);

      if (!order.triggered) {
        const stop = order.stopPrice as Decimal;
        const hit = order.side === 'BUY' ? ask.gte(stop) : bid.lte(stop);
        if (!hit) continue;
        order.triggered = true;
      }

      const executable = this.executablePrice(order, bid, ask);
      if (!executable) {
        if (order.timeInForce === TimeInForce.IOC || order.timeInForce === TimeInForce.FOK) {
          this.finishUnfilled(order);
          return order;
        }
        continue;
      }

      const remaining = order.requestedQty.minus(order.filledQty);
      const available = this.simulator.liquidityPerSecond(order.symbol);
      let quantity = Decimal.min(remaining, available);

      if (order.timeInForce === TimeInForce.FOK && quantity.lt(remaining)) {
        this.finishUnfilled(order);
        return order;
      }
      quantity = roundQuantity(quantity);
      if (quantity.lte(0)) continue;

      // Larger orders pay an impact cost on top of the spread.
      const impactBps = quantity.dividedBy(available).times(3);
      const fillPrice =
        order.side === 'BUY'
          ? executable.plus(executable.times(impactBps).dividedBy(10_000))
          : executable.minus(executable.times(impactBps).dividedBy(10_000));

      const affordable = this.applyFill(order, quantity, fillPrice.toDecimalPlaces(4), at);
      if (!affordable) return order;

      if (order.filledQty.gte(order.requestedQty)) {
        this.transition(order, OrderStatus.FILLED);
        order.updatedAt = new Date(at);
        return order;
      }
      if (order.timeInForce === TimeInForce.IOC) {
        this.finishUnfilled(order);
        return order;
      }
    }

    // A DAY order that outlived its session expires rather than resting forever.
    if (
      order.timeInForce === TimeInForce.DAY &&
      !isTerminalOrderStatus(order.status) &&
      !isSameUtcDay(new Date(order.submittedAt.getTime()), new Date(now))
    ) {
      this.transition(order, OrderStatus.EXPIRED);
      order.updatedAt = new Date(now);
    }
    return order;
  }

  /** The price an order can trade at right now, or null if it cannot. */
  private executablePrice(order: DemoOrderState, bid: Decimal, ask: Decimal): Decimal | null {
    const marketable =
      order.orderType === OrderType.MARKET ||
      (order.orderType === OrderType.STOP && order.triggered);
    if (marketable) return order.side === 'BUY' ? ask : bid;

    const limit = order.limitPrice as Decimal;
    if (order.side === 'BUY') return ask.lte(limit) ? Decimal.min(ask, limit) : null;
    return bid.gte(limit) ? Decimal.max(bid, limit) : null;
  }

  /** IOC/FOK remainder: the venue cancels what it could not fill immediately. */
  private finishUnfilled(order: DemoOrderState): void {
    this.transition(order, OrderStatus.CANCELLED);
    order.updatedAt = new Date(this.now());
  }

  /** Applies one fill; returns false when the account cannot pay for it. */
  private applyFill(
    order: DemoOrderState,
    quantity: Decimal,
    price: Decimal,
    atMs: number,
  ): boolean {
    const notional = quantity.times(price);
    const fees = this.feesFor(order.side, quantity, notional);

    if (order.side === 'BUY' && notional.plus(fees).gt(this.cash)) {
      // An order that runs out of money mid-fill keeps what it already got:
      // the remainder is cancelled, never silently dropped.
      order.rejectReason = 'Insufficient buying power';
      this.transition(order, order.filledQty.gt(0) ? OrderStatus.CANCELLED : OrderStatus.REJECTED);
      order.updatedAt = new Date(atMs);
      return false;
    }

    const execution: BrokerExecution = {
      executionId: `demo-exec-${randomUUID()}`,
      brokerOrderId: order.brokerOrderId,
      symbol: order.symbol,
      side: order.side,
      quantity,
      price,
      fees,
      executedAt: new Date(atMs),
      liquidityFlag: 'REMOVED',
    };
    order.executions.push(execution);
    order.filledQty = order.filledQty.plus(quantity);
    order.fees = order.fees.plus(fees);
    order.averageFillPrice = order.executions
      .reduce((sum, e) => sum.plus(e.price.times(e.quantity)), dec(0))
      .dividedBy(order.filledQty)
      .toDecimalPlaces(6);
    order.updatedAt = new Date(atMs);

    if (order.status !== OrderStatus.PARTIALLY_FILLED && order.filledQty.lt(order.requestedQty)) {
      this.transition(order, OrderStatus.PARTIALLY_FILLED);
    }

    this.cash =
      order.side === 'BUY'
        ? this.cash.minus(notional).minus(fees)
        : this.cash.plus(notional).minus(fees);
    this.applyToPosition(order.symbol, order.side, quantity, price, new Date(atMs));
    return true;
  }

  private feesFor(side: string, quantity: Decimal, notional: Decimal): Decimal {
    if (side !== 'SELL') return dec(0);
    const sec = notional.times(SEC_FEE_RATE);
    const taf = Decimal.min(quantity.times(TAF_PER_SHARE), dec(TAF_CAP));
    return roundMoney(sec.plus(taf));
  }

  private applyToPosition(
    symbol: string,
    side: string,
    quantity: Decimal,
    price: Decimal,
    at: Date,
  ): void {
    const existing =
      this.positions.get(symbol) ??
      ({
        symbol,
        quantity: dec(0),
        averageEntryPrice: dec(0),
        realizedPnl: dec(0),
        openedAt: at,
      } satisfies DemoPositionState);

    const signed = side === 'BUY' ? quantity : quantity.negated();
    const newQty = existing.quantity.plus(signed);
    const sameDirection = existing.quantity.isPositive() === signed.isPositive();

    if (existing.quantity.isZero() || sameDirection) {
      // Opening or adding: weighted-average cost.
      const cost = existing.averageEntryPrice
        .times(existing.quantity.abs())
        .plus(price.times(quantity));
      existing.averageEntryPrice = newQty.isZero()
        ? dec(0)
        : cost.dividedBy(newQty.abs()).toDecimalPlaces(6);
    } else {
      // Reducing or flipping: realise P&L on the closed quantity.
      const closed = Decimal.min(quantity, existing.quantity.abs());
      const direction = existing.quantity.isPositive() ? 1 : -1;
      existing.realizedPnl = existing.realizedPnl.plus(
        price.minus(existing.averageEntryPrice).times(closed).times(direction),
      );
      if (newQty.isZero()) {
        existing.averageEntryPrice = dec(0);
      } else if (newQty.isPositive() !== existing.quantity.isPositive()) {
        // The position flipped side; the new side's basis is this fill's price.
        existing.averageEntryPrice = price;
      }
    }

    existing.quantity = newQty;
    if (newQty.isZero()) existing.openedAt = at;
    this.positions.set(symbol, existing);
  }

  private preTradeReject(order: DemoOrderState): string | null {
    const session = this.simulator.sessionAt(new Date(this.now()));
    if (session === MarketSession.CLOSED && order.timeInForce === TimeInForce.IOC) {
      return 'Immediate-or-cancel orders are not accepted while the market is closed';
    }
    if (order.side === 'SELL') {
      const held = this.positions.get(order.symbol)?.quantity ?? dec(0);
      if (held.lt(order.requestedQty)) {
        // The demo account is cash-only: short selling is not offered.
        return 'Insufficient position to sell (the demo account does not permit short selling)';
      }
    }
    return null;
  }

  private transition(order: DemoOrderState, to: OrderStatus): void {
    if (order.status === to) return;
    assertOrderTransition(order.status, to);
    order.status = to;
  }

  private mustGet(brokerOrderId: string): DemoOrderState {
    const order = this.orders.get(brokerOrderId);
    if (!order)
      throw new BrokerError(`Unknown broker order ${brokerOrderId}`, false, brokerOrderId);
    return order;
  }

  /** Defensive copy — callers must not be able to mutate the venue's state. */
  private snapshot(order: DemoOrderState): BrokerOrder {
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
      executions: order.executions.map((e) => ({ ...e })),
    };
  }

  /** Test/seed helper: opens a position without routing an order through the book. */
  seedPosition(symbol: string, quantity: Decimal | number, averagePrice: Decimal | number): void {
    const qty = dec(quantity);
    const price = dec(averagePrice);
    this.positions.set(symbol.toUpperCase(), {
      symbol: symbol.toUpperCase(),
      quantity: qty,
      averageEntryPrice: price,
      realizedPnl: dec(0),
      openedAt: new Date(this.now()),
    });
    this.cash = this.cash.minus(qty.times(price));
  }

  reset(): void {
    this.orders.clear();
    this.ordersByIdempotencyKey.clear();
    this.positions.clear();
    this.cash = this.startingCash;
  }
}

function isSameUtcDay(a: Date, b: Date): boolean {
  return (
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth() &&
    a.getUTCDate() === b.getUTCDate()
  );
}

function nextFriday(from: Date): Date {
  const d = new Date(
    Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), 20, 0, 0),
  );
  const daysAhead = (5 - d.getUTCDay() + 7) % 7 || 7;
  d.setUTCDate(d.getUTCDate() + daysAhead);
  return d;
}

function occSymbol(underlying: string, expiration: Date, isCall: boolean, strike: number): string {
  const yy = String(expiration.getUTCFullYear()).slice(2);
  const mm = String(expiration.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(expiration.getUTCDate()).padStart(2, '0');
  const strikePart = String(Math.round(strike * 1000)).padStart(8, '0');
  return `${underlying}${yy}${mm}${dd}${isCall ? 'C' : 'P'}${strikePart}`;
}
