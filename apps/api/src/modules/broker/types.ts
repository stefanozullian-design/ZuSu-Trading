import type Decimal from 'decimal.js';
import type {
  AssetClass,
  MarketSession,
  OrderSide,
  OrderStatus,
  OrderType,
  TimeInForce,
  TradingEnvironment,
} from '@zusu/shared';

/**
 * The broker abstraction (§80).
 *
 * Nothing outside this folder knows which broker is in use. Adding a venue
 * means adding an adapter, never touching the trading engine.
 */

export type BrokerKind = 'DEMO' | 'PAPER' | 'ROBINHOOD';

export interface BrokerQuote {
  symbol: string;
  provider: string;
  price: Decimal;
  bid: Decimal;
  ask: Decimal;
  bidSize: Decimal;
  askSize: Decimal;
  volume: Decimal;
  /** When the venue says the quote was produced. */
  sourceTimestamp: Date;
  /** When this process received it — the pair drives staleness checks (§6). */
  receivedTimestamp: Date;
  marketSession: MarketSession;
}

export interface BrokerAccountSnapshot {
  accountId: string;
  environment: TradingEnvironment;
  currency: string;
  cash: Decimal;
  buyingPower: Decimal;
  equity: Decimal;
  maintenanceMargin: Decimal;
  isPatternDayTrader: boolean;
  updatedAt: Date;
}

export interface BrokerPosition {
  symbol: string;
  assetClass: AssetClass;
  quantity: Decimal;
  averageEntryPrice: Decimal;
  markPrice: Decimal;
  marketValue: Decimal;
  unrealizedPnl: Decimal;
  updatedAt: Date;
}

export interface BrokerExecution {
  executionId: string;
  brokerOrderId: string;
  symbol: string;
  side: OrderSide;
  quantity: Decimal;
  price: Decimal;
  fees: Decimal;
  executedAt: Date;
  liquidityFlag: 'ADDED' | 'REMOVED' | null;
}

export interface BrokerOrder {
  brokerOrderId: string;
  /** Echo of our idempotency key, so a reply can always be matched to a request. */
  clientOrderId: string;
  symbol: string;
  assetClass: AssetClass;
  side: OrderSide;
  orderType: OrderType;
  timeInForce: TimeInForce;
  status: OrderStatus;
  requestedQty: Decimal;
  filledQty: Decimal;
  averageFillPrice: Decimal | null;
  limitPrice: Decimal | null;
  stopPrice: Decimal | null;
  fees: Decimal;
  rejectReason: string | null;
  submittedAt: Date;
  updatedAt: Date;
  executions: BrokerExecution[];
}

export interface PlaceOrderRequest {
  /** Mandatory. Re-submitting the same key must never create a second order (§25). */
  idempotencyKey: string;
  symbol: string;
  assetClass: AssetClass;
  side: OrderSide;
  orderType: OrderType;
  timeInForce: TimeInForce;
  quantity: Decimal;
  limitPrice?: Decimal | null;
  stopPrice?: Decimal | null;
  /** Price the decision was based on; used to measure slippage (§28). */
  expectedPrice?: Decimal | null;
}

export interface OptionContractQuote {
  occSymbol: string;
  underlying: string;
  expiration: Date;
  strike: Decimal;
  isCall: boolean;
  bid: Decimal;
  ask: Decimal;
  midpoint: Decimal;
  spreadPct: Decimal;
  openInterest: number;
  volume: number;
  impliedVolatility: Decimal;
  delta: Decimal;
  gamma: Decimal;
  theta: Decimal;
  vega: Decimal;
}

export interface OptionsChain {
  underlying: string;
  asOf: Date;
  contracts: OptionContractQuote[];
}

export interface BrokerHealth {
  ok: boolean;
  latencyMs: number | null;
  detail: string | null;
  checkedAt: Date;
}

export interface BrokerAdapter {
  readonly kind: BrokerKind;
  /** The environment this adapter is allowed to operate in. Never crossed (§3). */
  readonly environment: TradingEnvironment;

  getAccount(): Promise<BrokerAccountSnapshot>;
  getPositions(): Promise<BrokerPosition[]>;
  getOrders(filter?: { openOnly?: boolean; since?: Date }): Promise<BrokerOrder[]>;
  getQuote(symbol: string): Promise<BrokerQuote>;
  placeOrder(request: PlaceOrderRequest): Promise<BrokerOrder>;
  cancelOrder(brokerOrderId: string): Promise<BrokerOrder>;
  getOrderStatus(brokerOrderId: string): Promise<BrokerOrder>;
  getOptionsChain(symbol: string, options?: { expiration?: Date }): Promise<OptionsChain>;
  healthCheck(): Promise<BrokerHealth>;
}

/** Raised when a broker call fails in a way the caller must not treat as success. */
export class BrokerError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly brokerOrderId?: string,
  ) {
    super(message);
    this.name = 'BrokerError';
  }
}
