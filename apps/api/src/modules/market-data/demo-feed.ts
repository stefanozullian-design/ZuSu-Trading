import type { PrismaClient } from '@prisma/client';
import { AssetClass, Decimal, MarketSession, dec } from '@zusu/shared';
import { DEMO_UNIVERSE, MarketSimulator } from '../broker/market-simulator.js';
import { MARKET_DEFINITIONS, buildCalendarDay, sessionAt } from './calendar.js';
import type { MarketCalendarService } from './calendar.service.js';
import type { MarketDataQualityService } from './quality.service.js';
import { zonedDateParts } from './time-zone.js';
import { TIMEFRAME_MINUTES, type ProviderCandle, type Timeframe } from './types.js';

/**
 * Candle backfill from the DEMO simulator.
 *
 * This exists so the market-data pipeline is observable without a provider
 * key. Bars are generated from the same deterministic simulator the demo
 * broker prices against, then pushed through `MarketDataQualityService` — the
 * real one, not a bypass — so quality inspection, persistence, de-duplication
 * and the indicator engine all run exactly as they will on live data.
 *
 * Two things it is careful not to pretend:
 *
 *   - Every row it writes carries `provider: 'demo-simulator'`, so no stored
 *     bar can be mistaken for a real one.
 *   - It only generates bars for instants the market calendar says the market
 *     was open. Inventing overnight bars would give the quality layer a series
 *     no real feed would ever produce, and make its gap detection look like it
 *     works when it had never been asked a real question.
 */

const NYSE = MARKET_DEFINITIONS.XNYS as (typeof MARKET_DEFINITIONS)['XNYS'];

export interface BackfillSummary {
  symbol: string;
  timeframe: Timeframe;
  generated: number;
  stored: number;
  rejected: number;
}

export class DemoFeed {
  private readonly simulator: MarketSimulator;

  constructor(
    private readonly db: PrismaClient,
    private readonly quality: MarketDataQualityService,
    private readonly calendar: MarketCalendarService,
    options: { seed?: number } = {},
  ) {
    this.simulator = new MarketSimulator({ seed: options.seed });
  }

  /** The symbols the demo feed covers. */
  symbols(): string[] {
    return DEMO_UNIVERSE.map((instrument) => instrument.symbol);
  }

  /**
   * Ensures an `Instrument` row exists for each demo symbol.
   *
   * The quality layer refuses to store a bar for an unknown symbol, so this
   * runs first rather than letting ingestion fail halfway.
   */
  async ensureInstruments(): Promise<void> {
    for (const instrument of DEMO_UNIVERSE) {
      const isEtf = ['SPY', 'QQQ', 'IWM'].includes(instrument.symbol);
      await this.db.instrument.upsert({
        where: { symbol: instrument.symbol },
        create: {
          symbol: instrument.symbol,
          name: instrument.symbol,
          assetClass: isEtf ? AssetClass.ETF : AssetClass.EQUITY,
          exchange: 'XNYS',
          isTradable: true,
        },
        update: {},
      });
    }
  }

  /**
   * Backfills one symbol over a window, writing only bars inside a session.
   *
   * Returns what was generated against what the quality layer accepted, so a
   * caller can see the pipeline actually ran rather than assuming it did.
   */
  async backfill(
    symbol: string,
    timeframe: Timeframe,
    from: Date,
    to: Date,
  ): Promise<BackfillSummary> {
    const intervalMs = TIMEFRAME_MINUTES[timeframe] * 60_000;
    const candles: ProviderCandle[] = [];

    // Bars sit on a fixed grid from the epoch, exactly as a real feed's do.
    // Anchoring them to `from` instead would move every bar's open time
    // whenever the backfill ran, so a second run would write a whole parallel
    // set of bars rather than upserting the existing ones.
    const firstBar = Math.ceil(from.getTime() / intervalMs) * intervalMs;

    for (let t = firstBar; t < to.getTime(); t += intervalMs) {
      const openTime = new Date(t);
      if (!this.shouldEmit(openTime, timeframe)) continue;
      candles.push(this.candleAt(symbol, timeframe, openTime, intervalMs));
    }

    if (candles.length === 0) {
      return { symbol, timeframe, generated: 0, stored: 0, rejected: 0 };
    }

    const isSessionGap = await this.calendar.gapResolverFor('XNYS', timeframe, from, to);
    const result = await this.quality.ingestCandles(candles, {
      provider: 'demo-simulator',
      isSessionGap,
    });

    return {
      symbol,
      timeframe,
      generated: candles.length,
      stored: result.stored,
      rejected: candles.length - result.stored,
    };
  }

  /** Backfills every demo symbol. */
  async backfillAll(timeframe: Timeframe, from: Date, to: Date): Promise<BackfillSummary[]> {
    await this.ensureInstruments();
    const summaries: BackfillSummary[] = [];
    for (const symbol of this.symbols()) {
      summaries.push(await this.backfill(symbol, timeframe, from, to));
    }
    return summaries;
  }

  /**
   * One bar, built from the simulator's price path across the interval.
   *
   * High and low come from sampling within the bar rather than from the open
   * and close, so the bar has a real range and ATR is not identically zero.
   */
  private candleAt(
    symbol: string,
    timeframe: Timeframe,
    openTime: Date,
    intervalMs: number,
  ): ProviderCandle {
    const start = openTime.getTime();
    const samples = 12;
    const prices: Decimal[] = [];
    for (let i = 0; i <= samples; i += 1) {
      prices.push(this.simulator.priceAt(symbol, start + (intervalMs * i) / samples));
    }

    const open = prices[0] as Decimal;
    const close = prices[prices.length - 1] as Decimal;
    let high = open;
    let low = open;
    for (const price of prices) {
      if (price.gt(high)) high = price;
      if (price.lt(low)) low = price;
    }

    const volume = this.simulator
      .liquidityPerSecond(symbol)
      .times(Math.round(intervalMs / 1_000))
      .toDecimalPlaces(0);

    return {
      symbol,
      timeframe,
      openTime,
      closeTime: new Date(start + intervalMs),
      open,
      high,
      low,
      close,
      volume,
      vwap: high.plus(low).plus(close).div(3).toDecimalPlaces(4),
      tradeCount: null,
      isAdjusted: true,
    };
  }

  /**
   * Whether a bar should exist at this instant, per the calendar.
   *
   * The question differs by timeframe. An intraday bar exists only if the
   * market was actually open at its open instant. A daily bar's open instant is
   * midnight, when no market is open, so asking the same question of it would
   * discard every daily bar — it represents the whole session, so the right
   * test is simply whether that date was a trading day.
   */
  private shouldEmit(at: Date, timeframe: Timeframe): boolean {
    if (timeframe === '1d') {
      // A daily bar keyed at UTC midnight *is* trading day D, so D is read
      // straight off the instant's UTC fields. Converting it to the market's
      // local date instead would land on D-1 — 00:00Z is the previous evening
      // in New York — and emit a bar for every Saturday labelled as Friday.
      return buildCalendarDay(NYSE, utcMidnight(at)).isTradingDay;
    }

    // An intraday bar belongs to the market-local date containing its instant,
    // which for a late-evening bar is not the same as its UTC date.
    const { year, month, day } = zonedDateParts(at, NYSE.timeZone);
    const calendarDay = buildCalendarDay(
      NYSE,
      new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0)),
    );
    return sessionAt(calendarDay, at) === MarketSession.REGULAR;
  }

  /** A live quote for a symbol, straight from the simulator. */
  quote(symbol: string, at: Date = new Date()) {
    const price = this.simulator.priceAt(symbol, at.getTime());
    const halfSpread = this.simulator.spreadAt(symbol, at.getTime());
    return {
      symbol,
      provider: 'demo-simulator',
      price,
      bid: price.minus(halfSpread),
      ask: price.plus(halfSpread),
      bidSize: dec(100),
      askSize: dec(100),
      volume: this.simulator.volumeAt(symbol, at.getTime()),
      sourceTimestamp: at,
      receivedTimestamp: at,
      marketSession: this.simulator.sessionAt(at),
    };
  }
}

function utcMidnight(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate(), 0, 0, 0, 0));
}
