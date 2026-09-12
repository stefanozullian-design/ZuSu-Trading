import { createHash } from 'node:crypto';
import {
  AssetClass,
  Decimal,
  MarketSession,
  OrderStatus,
  OrderType,
  TimeInForce,
  TradingEnvironment,
  dec,
  roundMoney,
  roundQuantity,
} from '@zusu/shared';
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
} from '../types.js';
import {
  ORDER_TYPE_MAP,
  REGULAR_HOURS_ONLY,
  TIME_IN_FORCE_MAP,
  type RobinhoodOrderState,
  type RobinhoodSession,
} from './contract.js';
import type { RobinhoodOrder, RobinhoodTransport } from './transport.js';

/**
 * The live Robinhood adapter (§80).
 *
 * Written against the capabilities recorded in `contract.ts` and exercised
 * against a fake transport. **It has never spoken to the live API**, because
 * this deployment has no Robinhood credentials — stated here so nobody infers
 * otherwise from the test count.
 *
 * Three gates stand between this class and a real order, and they are
 * independent on purpose:
 *
 *   1. `ALLOW_LIVE_TRADING` must be true for the deployment. It defaults to
 *      false and nothing in this codebase sets it.
 *   2. The adapter must be constructed with `liveOrdersEnabled`, a separate
 *      flag from the environment one, so switching a deployment on does not
 *      switch every account on with it.
 *   3. The broker's own `agentic_allowed` flag must be true for the account.
 *      That is Robinhood's version of the same rule this platform has: a
 *      person consents, per account.
 *
 * Any of the three being absent means `placeOrder` refuses. Reading — quotes,
 * positions, orders — is allowed regardless, because reconciliation has to be
 * able to see an account it may not trade.
 */

const PROVIDER = 'robinhood';

export interface RobinhoodBrokerOptions {
  accountNumber: string;
  transport: RobinhoodTransport;
  /**
   * Whether this adapter may place orders at all. Separate from
   * `ALLOW_LIVE_TRADING` so a deployment-wide switch and a per-account one
   * are two decisions rather than one.
   */
  liveOrdersEnabled: boolean;
  /** The deployment-wide switch, passed in rather than read here. */
  allowLiveTrading: boolean;
  /** The current session, so session rules are testable. */
  sessionAt?: (at: Date) => RobinhoodSession;
  now?: () => number;
}

export class RobinhoodBroker implements BrokerAdapter {
  readonly kind = 'ROBINHOOD' as const;
  readonly environment = TradingEnvironment.LIVE;

  private readonly accountNumber: string;
  private readonly transport: RobinhoodTransport;
  private readonly liveOrdersEnabled: boolean;
  private readonly allowLiveTrading: boolean;
  private readonly sessionAt: (at: Date) => RobinhoodSession;
  private readonly now: () => number;
  /** Fill quantity already reported per order, so a delta is only counted once. */
  private readonly reportedFills = new Map<string, Decimal>();

  constructor(options: RobinhoodBrokerOptions) {
    this.accountNumber = options.accountNumber;
    this.transport = options.transport;
    this.liveOrdersEnabled = options.liveOrdersEnabled;
    this.allowLiveTrading = options.allowLiveTrading;
    this.sessionAt = options.sessionAt ?? (() => 'regular_hours');
    this.now = options.now ?? (() => Date.now());
  }

  async getAccount(): Promise<BrokerAccountSnapshot> {
    const account = await this.transport.getAccount(this.accountNumber);
    return {
      accountId: account.account_number,
      environment: this.environment,
      currency: 'USD',
      cash: dec(account.cash),
      buyingPower: dec(account.buying_power),
      equity: dec(account.equity),
      maintenanceMargin: dec(0),
      isPatternDayTrader: false,
      updatedAt: new Date(this.now()),
    };
  }

  async getPositions(): Promise<BrokerPosition[]> {
    const positions = await this.transport.getPositions(this.accountNumber);
    return positions
      .filter((position) => !dec(position.quantity).isZero())
      .map((position) => {
        const quantity = dec(position.quantity);
        const entry = dec(position.average_buy_price);
        // Market value comes from the broker when it offers one; otherwise the
        // mark is the entry price and the unrealised figure is zero rather
        // than a number computed from a price nobody quoted.
        const marketValue = position.market_value
          ? dec(position.market_value)
          : entry.times(quantity);
        const mark = quantity.isZero() ? entry : marketValue.div(quantity);
        return {
          symbol: position.symbol,
          assetClass: AssetClass.EQUITY,
          quantity,
          averageEntryPrice: roundMoney(entry),
          markPrice: roundMoney(mark),
          marketValue: roundMoney(marketValue),
          unrealizedPnl: roundMoney(mark.minus(entry).times(quantity)),
          updatedAt: new Date(this.now()),
        };
      });
  }

  async getOrders(filter: { openOnly?: boolean; since?: Date } = {}): Promise<BrokerOrder[]> {
    const orders = await this.transport.getOrders(this.accountNumber, {
      ...(filter.since ? { since: filter.since } : {}),
    });
    const mapped = orders.map((order) => this.toBrokerOrder(order));
    return filter.openOnly ? mapped.filter((order) => !isTerminal(order.status)) : mapped;
  }

  async getQuote(symbol: string): Promise<BrokerQuote> {
    const quote = await this.transport.getQuote(symbol);
    const received = new Date(this.now());
    return {
      symbol: quote.symbol,
      provider: PROVIDER,
      price: dec(quote.last_trade_price),
      bid: dec(quote.bid_price),
      ask: dec(quote.ask_price),
      bidSize: dec(quote.bid_size),
      askSize: dec(quote.ask_size),
      volume: dec(quote.volume),
      // Both clocks, always: staleness cannot be judged from one of them.
      sourceTimestamp: new Date(quote.updated_at),
      receivedTimestamp: received,
      marketSession:
        this.sessionAt(received) === 'regular_hours'
          ? MarketSession.REGULAR
          : MarketSession.AFTER_HOURS,
    };
  }

  /**
   * Places a real order — if all three gates allow it.
   *
   * Every refusal below names which gate closed, because "the order did not go
   * through" is the least useful sentence a trading platform can produce.
   */
  async placeOrder(request: PlaceOrderRequest): Promise<BrokerOrder> {
    if (!this.allowLiveTrading) {
      throw new BrokerError(
        'Live trading is disabled on this deployment (ALLOW_LIVE_TRADING is false).',
        false,
      );
    }
    if (!this.liveOrdersEnabled) {
      throw new BrokerError(
        'This account is not enabled for live orders. Enabling it is a deliberate, ' +
          'per-account decision, separate from the deployment-wide switch.',
        false,
      );
    }
    if (request.assetClass !== AssetClass.EQUITY) {
      throw new BrokerError(
        'This adapter places equity orders only; multi-leg options go through placeOptionOrder.',
        false,
      );
    }

    const account = await this.transport.getAccount(this.accountNumber);
    if (!account.agentic_allowed) {
      // The broker's own record of consent. Refusing here rather than letting
      // the API reject it keeps the reason legible.
      throw new BrokerError(
        `Robinhood account ${this.accountNumber} is not enabled for automated placement ` +
          '(agentic_allowed is false). That consent is given at the broker, by a person.',
        false,
      );
    }

    const type = ORDER_TYPE_MAP[request.orderType];
    if (!type) {
      throw new BrokerError(
        `Robinhood has no equivalent for a ${request.orderType} order, and this adapter will ` +
          'not substitute the nearest thing.',
        false,
      );
    }

    const timeInForce = TIME_IN_FORCE_MAP[request.timeInForce];
    if (!timeInForce) {
      throw new BrokerError(
        `Robinhood supports day and good-till-cancelled orders only, so a ${request.timeInForce} ` +
          'order cannot be placed. Downgrading it silently would leave a resting order nobody asked for.',
        false,
      );
    }

    const session = this.sessionAt(new Date(this.now()));
    if (session !== 'regular_hours' && REGULAR_HOURS_ONLY.includes(type)) {
      // Placed anyway it would queue for the next open rather than fill, and a
      // trader would believe they were in the market.
      throw new BrokerError(
        `A ${type} order only executes in the regular session, and the market is currently in ` +
          `${session}. Use a limit order, or wait for the open.`,
        false,
      );
    }

    const placed = await this.transport.placeEquityOrder({
      account_number: this.accountNumber,
      symbol: request.symbol,
      side: request.side === 'BUY' ? 'buy' : 'sell',
      type,
      time_in_force: timeInForce,
      market_hours: session,
      quantity: request.quantity.toString(),
      // The platform's idempotency key, sent verbatim: the broker deduplicates
      // on it, so a retry cannot open a second position.
      ref_id: request.idempotencyKey,
      ...(request.limitPrice ? { price: request.limitPrice.toString() } : {}),
      ...(request.stopPrice ? { stop_price: request.stopPrice.toString() } : {}),
    });

    return this.toBrokerOrder(placed);
  }

  async cancelOrder(brokerOrderId: string): Promise<BrokerOrder> {
    const cancelled = await this.transport.cancelOrder(this.accountNumber, brokerOrderId);
    return this.toBrokerOrder(cancelled);
  }

  async getOrderStatus(brokerOrderId: string): Promise<BrokerOrder> {
    const order = await this.transport.getOrder(this.accountNumber, brokerOrderId);
    if (!order) throw new BrokerError(`Unknown order ${brokerOrderId}`, false);
    return this.toBrokerOrder(order);
  }

  getOptionsChain(): Promise<OptionsChain> {
    return Promise.reject(
      new BrokerError(
        'Options chains are read through the market-data provider rather than the broker.',
        false,
      ),
    );
  }

  async healthCheck(): Promise<BrokerHealth> {
    const started = Date.now();
    try {
      const account = await this.transport.getAccount(this.accountNumber);
      return {
        ok: true,
        latencyMs: Date.now() - started,
        detail: account.agentic_allowed
          ? 'account reachable and enabled for automated placement'
          : 'account reachable; automated placement not enabled at the broker',
        checkedAt: new Date(this.now()),
      };
    } catch (error) {
      return {
        ok: false,
        latencyMs: null,
        detail: error instanceof Error ? error.message : 'unknown failure',
        checkedAt: new Date(this.now()),
      };
    }
  }

  // --------------------------------------------------------------------------

  private toBrokerOrder(order: RobinhoodOrder): BrokerOrder {
    const filled = dec(order.cumulative_quantity);
    const status = translateState(order.state as RobinhoodOrderState);

    return {
      brokerOrderId: order.id,
      // A missing ref_id means the order was placed elsewhere — in the app, by
      // a recurring buy. Reconciliation needs to see it rather than have it
      // silently attributed to this platform.
      clientOrderId: order.ref_id ?? `external:${order.id}`,
      symbol: order.symbol,
      assetClass: AssetClass.EQUITY,
      side: order.side === 'buy' ? 'BUY' : 'SELL',
      orderType: translateType(order.type),
      timeInForce: order.time_in_force === 'gtc' ? TimeInForce.GTC : TimeInForce.DAY,
      status,
      requestedQty: dec(order.quantity),
      filledQty: filled,
      averageFillPrice: order.average_price ? dec(order.average_price) : null,
      limitPrice: order.price ? dec(order.price) : null,
      stopPrice: order.stop_price ? dec(order.stop_price) : null,
      fees: order.fees ? dec(order.fees) : dec(0),
      rejectReason: order.reject_reason,
      submittedAt: new Date(order.created_at),
      updatedAt: new Date(order.updated_at),
      executions: this.executionsFor(order, filled),
    };
  }

  /**
   * The fills to report for an order.
   *
   * When the broker exposes per-fill detail, that is used verbatim. When it
   * does not — see `contract.ts`, where the gap is recorded — one execution is
   * synthesised per observed increase in filled quantity, at the order's
   * average price, with an id that says it was synthesised. The platform
   * ingests executions idempotently by that id, so a repeated poll of an
   * unchanged order produces nothing new.
   */
  private executionsFor(order: RobinhoodOrder, filled: Decimal): BrokerExecution[] {
    if (order.executions && order.executions.length > 0) {
      return order.executions.map((execution, index) => ({
        executionId: execution.id ?? syntheticExecutionId(order.id, index),
        brokerOrderId: order.id,
        symbol: order.symbol,
        side: order.side === 'buy' ? 'BUY' : 'SELL',
        quantity: roundQuantity(dec(execution.quantity)),
        price: roundMoney(dec(execution.price)),
        fees: dec(0),
        executedAt: new Date(execution.timestamp),
        liquidityFlag: null,
      }));
    }

    const alreadyReported = this.reportedFills.get(order.id) ?? dec(0);
    const delta = filled.minus(alreadyReported);
    if (delta.lessThanOrEqualTo(0)) return [];

    this.reportedFills.set(order.id, filled);
    return [
      {
        // Deterministic in the filled quantity, so the same delta seen twice
        // is the same id and is ingested once.
        executionId: syntheticExecutionId(order.id, filled.toString()),
        brokerOrderId: order.id,
        symbol: order.symbol,
        side: order.side === 'buy' ? 'BUY' : 'SELL',
        quantity: roundQuantity(delta),
        price: roundMoney(dec(order.average_price ?? '0')),
        fees: order.fees ? dec(order.fees) : dec(0),
        executedAt: new Date(order.updated_at),
        liquidityFlag: null,
      },
    ];
  }
}

/**
 * A deterministic id for a fill the broker did not give one for.
 *
 * Prefixed so it is never mistaken for a broker execution id: a reconciliation
 * that cannot tell the two apart cannot be interpreted.
 */
export function syntheticExecutionId(orderId: string, discriminator: string | number): string {
  const hash = createHash('sha256')
    .update(`${orderId}:${String(discriminator)}`)
    .digest('hex')
    .slice(0, 24);
  return `synthetic:${hash}`;
}

export function translateState(state: RobinhoodOrderState): OrderStatus {
  switch (state) {
    case 'new':
    case 'unconfirmed':
      return OrderStatus.SUBMITTED;
    case 'queued':
    case 'confirmed':
      return OrderStatus.ACKNOWLEDGED;
    case 'partially_filled':
      return OrderStatus.PARTIALLY_FILLED;
    case 'filled':
      return OrderStatus.FILLED;
    case 'cancelled':
      return OrderStatus.CANCELLED;
    case 'rejected':
    case 'failed':
      return OrderStatus.REJECTED;
    case 'voided':
      return OrderStatus.EXPIRED;
    default:
      // A state this build does not recognise is UNKNOWN, never a guess. An
      // unrecognised state mapped to CANCELLED could hide a live position.
      return OrderStatus.UNKNOWN;
  }
}

function translateType(type: string): OrderType {
  switch (type) {
    case 'limit':
      return OrderType.LIMIT;
    case 'stop_market':
      return OrderType.STOP;
    case 'stop_limit':
      return OrderType.STOP_LIMIT;
    default:
      return OrderType.MARKET;
  }
}

function isTerminal(status: OrderStatus): boolean {
  return (
    status === OrderStatus.FILLED ||
    status === OrderStatus.CANCELLED ||
    status === OrderStatus.REJECTED ||
    status === OrderStatus.EXPIRED
  );
}
