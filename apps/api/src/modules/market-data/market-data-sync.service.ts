import type { PrismaClient } from '@prisma/client';
import { MarketDataError, type Timeframe } from './types.js';
import type { MarketDataProviderRegistry } from './provider-registry.js';
import type { MarketDataQualityService } from './quality.service.js';
import type { MarketCalendarService } from './calendar.service.js';

/**
 * Pulling real bars from the provider into the database.
 *
 * Everything needed for this existed separately and nothing joined it up: the
 * Massive adapter could fetch candles, the quality layer could inspect and
 * store them, and no code path led from one to the other. Setting an API key
 * bought a healthy status line and not a single real price.
 *
 * Three rules shape it:
 *
 *   1. **Real bars go through the same inspection as invented ones.** The
 *      quality layer checks staleness, gaps, duplicates and impossible values,
 *      and it runs here exactly as it runs for the demo simulator. A real feed
 *      is more likely to be wrong than a synthetic one, not less.
 *
 *   2. **Every row is tagged with the provider that produced it.** Real rows
 *      say `massive`, simulated rows say `demo-simulator`, and nothing can
 *      confuse the two afterwards.
 *
 *   3. **A failure is reported, never papered over.** If the provider refuses
 *      or the inspector rejects a batch, that symbol is reported as failed and
 *      the run continues to the next. Falling back to generated prices would
 *      be the market-data equivalent of demo credentials reaching a live venue.
 */

/**
 * How long to wait between provider calls.
 *
 * Massive's free tier allows a handful of requests per minute, and going over
 * earns a 429 that costs more time than pacing does. Twelve seconds is five
 * calls a minute — deliberately slow, and honest about why.
 */
export const DEFAULT_PACING_MS = 12_000;

export interface SymbolSyncResult {
  symbol: string;
  timeframe: Timeframe;
  /** Bars the provider returned. */
  fetched: number;
  /** Rows actually written after inspection. */
  stored: number;
  /** Quality findings, if the inspector had anything to say. */
  findings: string[];
  status: 'STORED' | 'NOTHING_RETURNED' | 'REJECTED' | 'FAILED';
  detail: string;
}

export interface SyncRun {
  provider: string;
  timeframe: Timeframe;
  from: Date;
  to: Date;
  results: SymbolSyncResult[];
  summary: string;
}

export interface SyncOptions {
  symbols?: string[];
  timeframe?: Timeframe;
  /** Calendar days back from `to`. */
  days?: number;
  to?: Date;
  pacingMs?: number;
  /** Called before each provider request, so a script can show progress. */
  onProgress?: (symbol: string, index: number, total: number) => void;
  /**
   * Called as each symbol finishes.
   *
   * A paced run takes minutes, and batching every result until the end leaves
   * the reader watching a stalled-looking line with no idea whether anything
   * is working.
   */
  onResult?: (result: SymbolSyncResult) => void;
}

export class MarketDataSyncService {
  constructor(
    private readonly db: PrismaClient,
    private readonly providers: MarketDataProviderRegistry,
    private readonly quality: MarketDataQualityService,
    private readonly calendar: MarketCalendarService,
  ) {}

  /**
   * The symbols worth syncing: every instrument the platform knows and is
   * willing to trade. Watchlists are built from these, so this is a superset
   * of anything a strategy or scan can reach.
   */
  async syncableSymbols(): Promise<string[]> {
    const rows = await this.db.instrument.findMany({
      where: { isTradable: true },
      select: { symbol: true },
      orderBy: { symbol: 'asc' },
    });
    return rows.map((row) => row.symbol);
  }

  async sync(options: SyncOptions = {}): Promise<SyncRun> {
    // Refuses rather than substituting: with no provider there is nothing
    // honest to do here, and generating bars would be a lie with a timestamp.
    const provider = this.providers.resolve();

    const timeframe = options.timeframe ?? ('1d' as Timeframe);
    const to = options.to ?? new Date();
    const days = options.days ?? 365;
    const from = new Date(to.getTime() - days * 86_400_000);
    const pacingMs = options.pacingMs ?? DEFAULT_PACING_MS;

    const symbols = options.symbols?.length
      ? options.symbols.map((s) => s.trim().toUpperCase())
      : await this.syncableSymbols();

    const results: SymbolSyncResult[] = [];

    for (const [index, symbol] of symbols.entries()) {
      if (index > 0 && pacingMs > 0) await delay(pacingMs);
      options.onProgress?.(symbol, index, symbols.length);
      const result = await this.syncSymbol(provider.name, symbol, timeframe, from, to);
      options.onResult?.(result);
      results.push(result);
    }

    const stored = results.reduce((total, result) => total + result.stored, 0);
    const failed = results.filter((result) => result.status === 'FAILED');

    return {
      provider: provider.name,
      timeframe,
      from,
      to,
      results,
      summary:
        `${String(stored)} bars stored across ${String(symbols.length)} symbols from ` +
        `${provider.name}` +
        (failed.length > 0
          ? `; ${String(failed.length)} failed: ${failed.map((f) => f.symbol).join(', ')}`
          : ''),
    };
  }

  private async syncSymbol(
    providerName: string,
    symbol: string,
    timeframe: Timeframe,
    from: Date,
    to: Date,
  ): Promise<SymbolSyncResult> {
    const base: Omit<SymbolSyncResult, 'status' | 'detail'> = {
      symbol,
      timeframe,
      fetched: 0,
      stored: 0,
      findings: [],
    };

    let candles;
    try {
      candles = await this.providers.resolve().getCandles({ symbol, timeframe, from, to });
    } catch (error) {
      const retryable = error instanceof MarketDataError && error.retryable;
      return {
        ...base,
        status: 'FAILED',
        detail:
          `${providerName} refused: ${error instanceof Error ? error.message : 'unknown error'}` +
          (retryable ? ' (retryable — the run continues to the next symbol)' : ''),
      };
    }

    if (candles.length === 0) {
      return {
        ...base,
        status: 'NOTHING_RETURNED',
        // Overwhelmingly the plan rather than a fault, and worth saying so:
        // an end-of-day plan returns nothing at all for an intraday timeframe.
        detail:
          `${providerName} returned no ${timeframe} bars for ${symbol} in this window. On a ` +
          'plan without intraday data this is the expected answer, not a failure.',
      };
    }

    // The instrument's own market decides what counts as a gap. A hole
    // spanning a weekend is not missing data; the same hole on a Tuesday is.
    const instrument = await this.db.instrument.findUnique({
      where: { symbol },
      select: { exchange: true },
    });
    const isSessionGap = await this.calendar.gapResolverFor(
      instrument?.exchange ?? 'XNYS',
      timeframe,
      from,
      to,
    );
    const result = await this.quality.ingestCandles(candles, {
      provider: providerName,
      isSessionGap,
    });

    return {
      ...base,
      fetched: candles.length,
      stored: result.stored,
      findings: result.findings.map((finding) => `${finding.issue}: ${finding.detail}`),
      status: result.accepted ? 'STORED' : 'REJECTED',
      detail: result.accepted
        ? `${String(result.stored)} of ${String(candles.length)} bars stored.`
        : `Inspection rejected this batch; ${String(result.stored)} bars stored. The findings ` +
          'are recorded and block trading until resolved.',
    };
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
