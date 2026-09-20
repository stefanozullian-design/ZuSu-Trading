import { AssetClass, dec, type Decimal } from '@zusu/shared';
import {
  MarketDataError,
  TIMEFRAME_MINUTES,
  type CandleQuery,
  type CorporateAction,
  type MarketDataProvider,
  type MarketDataProviderKind,
  type ProviderCalendarDay,
  type ProviderCandle,
  type ProviderHealth,
  type ProviderInstrument,
  type ProviderQuote,
  type Timeframe,
} from './types.js';

/**
 * Massive.com adapter.
 *
 * Massive is the former Polygon.io, rebranded on 2025-10-30. The REST surface
 * is unchanged and the legacy host still answers, but it is scheduled to be
 * retired, so the default base URL is `api.massive.com` and the old host is
 * reachable only by setting MASSIVE_BASE_URL explicitly.
 *
 * Deliberately built on `fetch` rather than Massive's SDK: the SDK returns
 * numbers (a float cannot hold a price exactly), hides the HTTP status behind
 * thrown strings, and offers no injection point for a fake transport. All three
 * matter more here than the convenience it buys.
 *
 * Endpoint mapping, and where Massive cannot answer:
 *
 *   getQuote            v2/snapshot/.../tickers/{t}   last trade + NBBO + day volume
 *   getCandles          v2/aggs/ticker/{t}/range/...  paginated via next_url
 *   getCorporateActions v3/reference/splits, v3/reference/dividends
 *   searchInstruments   v3/reference/tickers?search=
 *   getCalendar         v1/marketstatus/upcoming      UPCOMING HOLIDAYS ONLY
 *
 * `getCalendar` is the weak spot and the caller must know it: Massive exposes
 * upcoming holidays and early closes, not a historical session calendar with
 * per-day pre/post boundaries. Days this adapter has no holiday record for are
 * returned with `isTradingDay` derived from the weekday and null session
 * boundaries, so the calendar engine can tell "open, times unknown" from
 * "closed, and here is why". Backfilling historical sessions needs a second
 * source, or derivation from daily aggregates.
 */

interface MassiveProviderOptions {
  apiKey: string;
  /** Overridable for tests. */
  baseUrl?: string;
  /** Per-request timeout. Massive aggregates over long ranges can be slow. */
  timeoutMs?: number;
  /** Injection point for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /**
   * True when the plan serves 15-minute-delayed data. A delayed feed must never
   * authorise a live entry, so this is explicit rather than inferred.
   */
  isDelayed?: boolean;
}

/** Massive's `timespan`/`multiplier` pair for each of our timeframes. */
const AGG_SPEC: Record<Timeframe, { multiplier: number; timespan: string }> = {
  '1m': { multiplier: 1, timespan: 'minute' },
  '5m': { multiplier: 5, timespan: 'minute' },
  '15m': { multiplier: 15, timespan: 'minute' },
  '1h': { multiplier: 1, timespan: 'hour' },
  '1d': { multiplier: 1, timespan: 'day' },
};

/** Massive ticker types that we treat as ETFs rather than ordinary equity. */
const ETF_TYPES = new Set(['ETF', 'ETN', 'ETV', 'FUND']);

interface SnapshotResponse {
  ticker?: {
    ticker?: string;
    day?: { v?: number };
    lastTrade?: { p?: number; t?: number };
    lastQuote?: { P?: number; S?: number; p?: number; s?: number; t?: number };
    min?: { v?: number; t?: number };
    updated?: number;
  };
}

interface AggregatesResponse {
  results?: {
    t?: number;
    o?: number;
    h?: number;
    l?: number;
    c?: number;
    v?: number;
    vw?: number;
    n?: number;
  }[];
  next_url?: string;
}

/** What one response disclosed about the plan's rate limit. */
export interface RateLimitReading {
  limit: number | null;
  remaining: number | null;
  /** Providers disagree on whether this is a delay or an epoch. Kept raw. */
  resetRaw: string | null;
  retryAfterRaw: string | null;
  /** The rate-limit headers this response actually carried. */
  headers: string[];
}

const RATE_HEADERS = [
  'x-ratelimit-limit',
  'x-ratelimit-remaining',
  'x-ratelimit-reset',
  'ratelimit-limit',
  'ratelimit-remaining',
  'ratelimit-reset',
  'retry-after',
] as const;

/** Reads whichever rate-limit headers are present, and records which were. */
export function readRateLimit(headers: Headers): RateLimitReading {
  const seen = RATE_HEADERS.filter((name) => headers.get(name) !== null);
  const num = (...names: string[]): number | null => {
    for (const name of names) {
      const raw = headers.get(name);
      if (raw === null) continue;
      const parsed = Number(raw);
      if (Number.isFinite(parsed)) return parsed;
    }
    return null;
  };

  return {
    limit: num('x-ratelimit-limit', 'ratelimit-limit'),
    remaining: num('x-ratelimit-remaining', 'ratelimit-remaining'),
    resetRaw: headers.get('x-ratelimit-reset') ?? headers.get('ratelimit-reset'),
    retryAfterRaw: headers.get('retry-after'),
    headers: [...seen],
  };
}

export class MassiveProvider implements MarketDataProvider {
  readonly kind: MarketDataProviderKind = 'MASSIVE';
  readonly name = 'massive';
  readonly isDelayed: boolean;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private rateLimitRemaining: number | null = null;
  private lastReading: RateLimitReading | null = null;

  constructor(options: MassiveProviderOptions) {
    if (!options.apiKey) {
      throw new Error('MassiveProvider requires an API key');
    }
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? 'https://api.massive.com').replace(/\/$/, '');
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.isDelayed = options.isDelayed ?? true;
  }

  async getQuote(symbol: string): Promise<ProviderQuote> {
    const ticker = normaliseSymbol(symbol);
    const body = await this.request<SnapshotResponse>(
      `/v2/snapshot/locale/us/markets/stocks/tickers/${encodeURIComponent(ticker)}`,
    );
    const snap = body.ticker;
    if (!snap) {
      throw new MarketDataError(`Massive returned no snapshot for ${ticker}`, false, 404);
    }

    const receivedTimestamp = new Date();
    const lastQuote = snap.lastQuote ?? {};
    const lastTrade = snap.lastTrade ?? {};

    // Prefer the trade clock, fall back to the quote clock, then the envelope's
    // own `updated`. Never substitute our own clock: that would make a frozen
    // feed look perfectly fresh, which is the exact failure staleness detection
    // exists to catch.
    const sourceNs = lastTrade.t ?? lastQuote.t ?? snap.updated;
    if (sourceNs === undefined) {
      throw new MarketDataError(
        `Massive snapshot for ${ticker} carries no timestamp; staleness cannot be judged`,
        false,
      );
    }

    return {
      symbol: ticker,
      provider: this.name,
      price: optionalDecimal(lastTrade.p),
      bid: optionalDecimal(lastQuote.p),
      ask: optionalDecimal(lastQuote.P),
      bidSize: optionalDecimal(lastQuote.s),
      askSize: optionalDecimal(lastQuote.S),
      volume: optionalDecimal(snap.day?.v),
      sourceTimestamp: fromNanos(sourceNs),
      receivedTimestamp,
      // Massive's snapshot carries no session field. The calendar engine decides.
      marketSession: null,
    };
  }

  async getQuotes(symbols: string[]): Promise<ProviderQuote[]> {
    const unique = [...new Set(symbols.map(normaliseSymbol))];
    if (unique.length === 0) return [];
    // Sequential on purpose: Massive rate-limits per minute and a parallel burst
    // is the quickest way to get every request in the batch rejected.
    const quotes: ProviderQuote[] = [];
    for (const symbol of unique) {
      quotes.push(await this.getQuote(symbol));
    }
    return quotes;
  }

  async getCandles(query: CandleQuery): Promise<ProviderCandle[]> {
    const ticker = normaliseSymbol(query.symbol);
    const spec = AGG_SPEC[query.timeframe];
    if (!spec) {
      throw new MarketDataError(`Unsupported timeframe ${query.timeframe}`, false);
    }
    if (query.from.getTime() > query.to.getTime()) {
      throw new MarketDataError('Candle query `from` is after `to`', false);
    }

    const adjusted = query.adjusted ?? true;
    const params = new URLSearchParams({
      adjusted: String(adjusted),
      sort: 'asc',
      limit: String(Math.min(query.limit ?? 50_000, 50_000)),
    });
    let path =
      `/v2/aggs/ticker/${encodeURIComponent(ticker)}/range/${spec.multiplier}/${spec.timespan}` +
      `/${isoDate(query.from)}/${isoDate(query.to)}?${params.toString()}`;

    const candles: ProviderCandle[] = [];
    const durationMs = TIMEFRAME_MINUTES[query.timeframe] * 60_000;
    // Bounded so a malformed `next_url` cannot spin forever.
    for (let page = 0; page < 50; page += 1) {
      const body = await this.request<AggregatesResponse>(path);
      for (const bar of body.results ?? []) {
        if (
          bar.t === undefined ||
          bar.o === undefined ||
          bar.h === undefined ||
          bar.l === undefined ||
          bar.c === undefined
        ) {
          // A partial bar is dropped rather than zero-filled; the quality layer
          // reports the resulting gap as MISSING_CANDLE.
          continue;
        }
        const openTime = new Date(bar.t);
        candles.push({
          symbol: ticker,
          timeframe: query.timeframe,
          openTime,
          closeTime: new Date(bar.t + durationMs),
          open: dec(bar.o),
          high: dec(bar.h),
          low: dec(bar.l),
          close: dec(bar.c),
          volume: dec(bar.v ?? 0),
          vwap: optionalDecimal(bar.vw),
          tradeCount: bar.n ?? null,
          isAdjusted: adjusted,
        });
      }
      if (!body.next_url) break;
      path = body.next_url.replace(this.baseUrl, '');
    }
    return candles;
  }

  async getCorporateActions(symbol: string, from: Date, to: Date): Promise<CorporateAction[]> {
    const ticker = normaliseSymbol(symbol);
    const actions: CorporateAction[] = [];

    const splits = await this.request<{
      results?: { execution_date?: string; split_from?: number; split_to?: number }[];
    }>(
      `/v3/reference/splits?ticker=${encodeURIComponent(ticker)}` +
        `&execution_date.gte=${isoDate(from)}&execution_date.lte=${isoDate(to)}&limit=1000`,
    );
    for (const split of splits.results ?? []) {
      if (!split.execution_date || !split.split_from || !split.split_to) continue;
      actions.push({
        symbol: ticker,
        type: 'SPLIT',
        effectiveDate: new Date(`${split.execution_date}T00:00:00Z`),
        // 7-for-1 arrives as split_to=7, split_from=1.
        splitRatio: dec(split.split_to).div(dec(split.split_from)),
        cashAmount: null,
        fromSymbol: null,
        toSymbol: null,
      });
    }

    const dividends = await this.request<{
      results?: { ex_dividend_date?: string; cash_amount?: number }[];
    }>(
      `/v3/reference/dividends?ticker=${encodeURIComponent(ticker)}` +
        `&ex_dividend_date.gte=${isoDate(from)}&ex_dividend_date.lte=${isoDate(to)}&limit=1000`,
    );
    for (const dividend of dividends.results ?? []) {
      if (!dividend.ex_dividend_date || dividend.cash_amount === undefined) continue;
      actions.push({
        symbol: ticker,
        type: 'DIVIDEND',
        effectiveDate: new Date(`${dividend.ex_dividend_date}T00:00:00Z`),
        splitRatio: null,
        cashAmount: dec(dividend.cash_amount),
        fromSymbol: null,
        toSymbol: null,
      });
    }

    // Ticker changes live behind Massive's experimental vX events endpoint and
    // are not read here. A rename that goes unnoticed shows up as a data gap
    // rather than a silently wrong price series.
    actions.sort((a, b) => a.effectiveDate.getTime() - b.effectiveDate.getTime());
    return actions;
  }

  async searchInstruments(query: string, limit = 20): Promise<ProviderInstrument[]> {
    const body = await this.request<{
      results?: {
        ticker?: string;
        name?: string;
        type?: string;
        primary_exchange?: string;
        market?: string;
        active?: boolean;
        sic_description?: string;
      }[];
    }>(
      `/v3/reference/tickers?search=${encodeURIComponent(query)}` +
        `&active=true&limit=${Math.min(limit, 1000)}`,
    );

    const instruments: ProviderInstrument[] = [];
    for (const row of body.results ?? []) {
      if (!row.ticker) continue;
      instruments.push({
        symbol: row.ticker,
        name: row.name ?? row.ticker,
        assetClass: assetClassOf(row.type, row.market),
        marketCode: row.primary_exchange ?? null,
        sector: row.sic_description ?? null,
        isActive: row.active ?? true,
      });
    }
    return instruments;
  }

  async getCalendar(marketCode: string, from: Date, to: Date): Promise<ProviderCalendarDay[]> {
    const upcoming = await this.request<
      {
        date?: string;
        exchange?: string;
        name?: string;
        status?: string;
        open?: string;
        close?: string;
      }[]
    >('/v1/marketstatus/upcoming');

    // Massive names exchanges NYSE/NASDAQ here rather than by MIC.
    const wanted = EXCHANGE_ALIASES[marketCode] ?? new Set([marketCode]);
    const byDate = new Map<string, (typeof upcoming)[number]>();
    for (const entry of Array.isArray(upcoming) ? upcoming : []) {
      if (!entry.date) continue;
      if (entry.exchange && !wanted.has(entry.exchange)) continue;
      byDate.set(entry.date, entry);
    }

    const days: ProviderCalendarDay[] = [];
    for (const date of eachUtcDate(from, to)) {
      const key = isoDate(date);
      const holiday = byDate.get(key);
      const weekend = date.getUTCDay() === 0 || date.getUTCDay() === 6;

      if (holiday && holiday.status === 'closed') {
        days.push({
          marketCode,
          date,
          isTradingDay: false,
          preMarketOpen: null,
          regularOpen: null,
          regularClose: null,
          afterHoursClose: null,
          isEarlyClose: false,
          holidayName: holiday.name ?? 'market holiday',
        });
        continue;
      }

      if (holiday && holiday.open && holiday.close) {
        // An early close — Massive gives the actual boundaries for these.
        days.push({
          marketCode,
          date,
          isTradingDay: true,
          preMarketOpen: null,
          regularOpen: new Date(holiday.open),
          regularClose: new Date(holiday.close),
          afterHoursClose: null,
          isEarlyClose: true,
          holidayName: holiday.name ?? null,
        });
        continue;
      }

      // No holiday record. Weekday means open, but Massive has told us nothing
      // about the session boundaries, so they stay null rather than being
      // guessed at 09:30/16:00 — the exact hard-coding §7 forbids.
      days.push({
        marketCode,
        date,
        isTradingDay: !weekend,
        preMarketOpen: null,
        regularOpen: null,
        regularClose: null,
        afterHoursClose: null,
        isEarlyClose: false,
        holidayName: null,
      });
    }
    return days;
  }

  /**
   * What the last response said about the rate limit.
   *
   * Returned as a reading rather than a number, because "no headers at all"
   * and "zero remaining" are different answers and a single nullable number
   * cannot tell them apart. `headers` names what the response actually
   * carried, so a caller can say "this provider does not report a limit"
   * instead of quietly presenting silence as headroom.
   */
  lastRateLimit(): RateLimitReading | null {
    return this.lastReading;
  }

  async healthCheck(): Promise<ProviderHealth> {
    const started = Date.now();
    try {
      await this.request<{ market?: string }>('/v1/marketstatus/now');
      return {
        ok: true,
        latencyMs: Date.now() - started,
        detail: this.isDelayed ? 'delayed feed' : 'real-time feed',
        checkedAt: new Date(),
        rateLimitRemaining: this.rateLimitRemaining,
      };
    } catch (err) {
      return {
        ok: false,
        latencyMs: null,
        detail: err instanceof Error ? err.message : 'unknown error',
        checkedAt: new Date(),
        rateLimitRemaining: this.rateLimitRemaining,
      };
    }
  }

  /**
   * One place where every Massive response is turned into either typed data or
   * a `MarketDataError`. The API key travels in a header rather than the query
   * string so it cannot leak into a log line or an error message.
   */
  private async request<T>(path: string): Promise<T> {
    const url = path.startsWith('http') ? path : `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: 'application/json',
        },
        signal: controller.signal,
      });
    } catch (err) {
      const aborted = err instanceof Error && err.name === 'AbortError';
      throw new MarketDataError(
        aborted ? `Massive request timed out after ${this.timeoutMs}ms` : 'Massive request failed',
        true,
      );
    } finally {
      clearTimeout(timer);
    }

    this.lastReading = readRateLimit(response.headers);
    if (this.lastReading.remaining !== null) this.rateLimitRemaining = this.lastReading.remaining;

    if (response.status === 429) {
      throw new MarketDataError('Massive rate limit exceeded', true, 429);
    }
    if (response.status === 401 || response.status === 403) {
      // Never retried: a bad or unentitled key will not fix itself, and
      // retrying it looks like a brute-force attempt from Massive's side.
      throw new MarketDataError(
        'Massive rejected the API key or the plan does not cover this endpoint',
        false,
        response.status,
      );
    }
    if (!response.ok) {
      throw new MarketDataError(
        `Massive responded ${response.status}`,
        response.status >= 500,
        response.status,
      );
    }

    try {
      return (await response.json()) as T;
    } catch {
      throw new MarketDataError('Massive returned a malformed JSON body', true, response.status);
    }
  }
}

/** Massive names exchanges by acronym in the market-status endpoints. */
const EXCHANGE_ALIASES: Record<string, Set<string>> = {
  XNYS: new Set(['NYSE', 'XNYS']),
  XNAS: new Set(['NASDAQ', 'XNAS']),
};

function normaliseSymbol(symbol: string): string {
  const trimmed = symbol.trim().toUpperCase();
  if (!trimmed) {
    throw new MarketDataError('Symbol is required', false);
  }
  return trimmed;
}

/**
 * Absent stays absent. A provider that omits a bid must not be turned into a
 * bid of zero, which would read downstream as a real and catastrophic price.
 */
function optionalDecimal(value: number | undefined | null): Decimal | null {
  if (value === undefined || value === null) return null;
  if (!Number.isFinite(value)) return null;
  return dec(value);
}

/** Massive reports trade and quote clocks in nanoseconds since the epoch. */
function fromNanos(nanos: number): Date {
  return new Date(Math.floor(nanos / 1_000_000));
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function* eachUtcDate(from: Date, to: Date): Generator<Date> {
  const cursor = new Date(
    Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), 0, 0, 0, 0),
  );
  const end = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate(), 0, 0, 0, 0);
  while (cursor.getTime() <= end) {
    yield new Date(cursor.getTime());
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
}

function assetClassOf(type: string | undefined, market: string | undefined): AssetClass {
  if (market === 'crypto') return AssetClass.CRYPTO;
  if (type && ETF_TYPES.has(type)) return AssetClass.ETF;
  return AssetClass.EQUITY;
}
