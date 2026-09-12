import type Decimal from 'decimal.js';
import type { AssetClass, MarketSession } from '@zusu/shared';

/**
 * The market-data abstraction (§6, §7).
 *
 * Nothing outside this folder knows which data vendor is in use, exactly as
 * nothing outside `modules/broker` knows which venue is. Adding a provider
 * means adding an adapter; the quality layer, calendar engine and indicator
 * engine are written against this interface only.
 *
 * Two rules the interface exists to enforce:
 *
 *   1. Every price carries both the provider's timestamp and ours. Staleness
 *      cannot be judged from one clock, so the pair is mandatory rather than
 *      optional (contrast a vendor SDK, which typically gives you neither).
 *   2. Absent data is `null`, never a substituted stand-in. A provider that
 *      cannot answer must say so, so that the quality layer can block trades
 *      instead of a strategy silently trading on a fabricated price.
 */

export type MarketDataProviderKind = 'FIXTURE' | 'MASSIVE';

/** Candle timeframes the platform understands. Mirrors `MarketDataCandle.timeframe`. */
export const TIMEFRAMES = ['1m', '5m', '15m', '1h', '1d'] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];

/** Minutes per timeframe — used for gap detection and request windowing. */
export const TIMEFRAME_MINUTES: Record<Timeframe, number> = {
  '1m': 1,
  '5m': 5,
  '15m': 15,
  '1h': 60,
  '1d': 1440,
};

export interface ProviderQuote {
  symbol: string;
  provider: string;
  /** Last trade price. Null when the provider has no trade to report. */
  price: Decimal | null;
  bid: Decimal | null;
  ask: Decimal | null;
  bidSize: Decimal | null;
  askSize: Decimal | null;
  volume: Decimal | null;
  /** When the provider says the data was produced. */
  sourceTimestamp: Date;
  /** When this process received it. The pair drives staleness checks (§6). */
  receivedTimestamp: Date;
  /**
   * The provider's own view of the session, where it has one. The calendar
   * engine is authoritative; this is recorded for cross-checking, not trusted.
   */
  marketSession: MarketSession | null;
}

export interface ProviderCandle {
  symbol: string;
  timeframe: Timeframe;
  openTime: Date;
  closeTime: Date;
  open: Decimal;
  high: Decimal;
  low: Decimal;
  close: Decimal;
  volume: Decimal;
  vwap: Decimal | null;
  tradeCount: number | null;
  /** Whether the provider adjusted for splits and dividends. */
  isAdjusted: boolean;
}

/**
 * A split, dividend or ticker change. Required for Phase 4: a backtest that
 * ignores these reads a 7-for-1 split as an 86% crash.
 */
export interface CorporateAction {
  symbol: string;
  type: 'SPLIT' | 'DIVIDEND' | 'TICKER_CHANGE';
  effectiveDate: Date;
  /** Post/pre ratio for a split — 7-for-1 is 7. Null for other types. */
  splitRatio: Decimal | null;
  /** Cash amount per share for a dividend. Null for other types. */
  cashAmount: Decimal | null;
  /** Previous and new ticker for a rename. Null for other types. */
  fromSymbol: string | null;
  toSymbol: string | null;
}

export interface ProviderInstrument {
  symbol: string;
  name: string;
  assetClass: AssetClass;
  /** MIC of the primary listing venue, e.g. XNYS, XNAS. Null for crypto. */
  marketCode: string | null;
  sector: string | null;
  isActive: boolean;
}

/**
 * One trading day as the provider describes it. The calendar engine turns a
 * sequence of these into `market_calendar_days`; no session boundary is ever
 * hard-coded (§7).
 */
export interface ProviderCalendarDay {
  marketCode: string;
  /** Calendar date in the market's own local timezone. */
  date: Date;
  isTradingDay: boolean;
  preMarketOpen: Date | null;
  regularOpen: Date | null;
  regularClose: Date | null;
  afterHoursClose: Date | null;
  isEarlyClose: boolean;
  holidayName: string | null;
}

export interface ProviderHealth {
  ok: boolean;
  latencyMs: number | null;
  detail: string | null;
  checkedAt: Date;
  /**
   * Requests left in the current window, where the provider reports it. Null
   * when unknown — which the caller must treat as "unknown", not "plenty".
   */
  rateLimitRemaining: number | null;
}

export interface CandleQuery {
  symbol: string;
  timeframe: Timeframe;
  from: Date;
  to: Date;
  /** Split/dividend-adjusted prices. Defaults to true. */
  adjusted?: boolean;
  limit?: number;
}

export interface MarketDataProvider {
  readonly kind: MarketDataProviderKind;
  /** Provider name recorded on every stored quote and candle, for provenance. */
  readonly name: string;
  /**
   * True when this provider's data is delayed rather than real-time. A delayed
   * feed is legitimate for research and backtesting and must never be used to
   * authorise a live entry, so the flag travels with the adapter.
   */
  readonly isDelayed: boolean;

  getQuote(symbol: string): Promise<ProviderQuote>;
  getQuotes(symbols: string[]): Promise<ProviderQuote[]>;
  getCandles(query: CandleQuery): Promise<ProviderCandle[]>;
  getCorporateActions(symbol: string, from: Date, to: Date): Promise<CorporateAction[]>;
  searchInstruments(query: string, limit?: number): Promise<ProviderInstrument[]>;
  getCalendar(marketCode: string, from: Date, to: Date): Promise<ProviderCalendarDay[]>;
  healthCheck(): Promise<ProviderHealth>;
}

/**
 * Raised when a provider call fails in a way the caller must not read as
 * success. `retryable` distinguishes a rate limit or timeout from a bad symbol.
 */
export class MarketDataError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'MarketDataError';
  }
}
