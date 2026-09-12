import type { PrismaClient } from '@prisma/client';
import { type Decimal, dec } from '@zusu/shared';
import {
  atr,
  bollinger,
  closes,
  ema,
  macd,
  obv,
  rsi,
  sma,
  stochastic,
  vwap,
} from './indicators.js';
import type { ProviderCandle, Timeframe } from './types.js';

/**
 * Computes indicators over stored candles (§8).
 *
 * A thin layer on purpose: it loads bars and calls the pure functions. All the
 * arithmetic — and every guarantee about alignment, warm-up and causality —
 * lives in `indicators.ts`, where it is testable without a database.
 *
 * Results are not persisted. An indicator is a pure function of the candles
 * plus its parameters, so storing it would create a second source of truth to
 * keep in step for no benefit; the candles are the record.
 */

export interface IndicatorSnapshot {
  symbol: string;
  timeframe: Timeframe;
  /** Bar this snapshot is as of. Every value below is that bar's value. */
  asOf: Date;
  close: Decimal;
  sma20: Decimal | null;
  sma50: Decimal | null;
  ema12: Decimal | null;
  ema26: Decimal | null;
  rsi14: Decimal | null;
  macd: Decimal | null;
  macdSignal: Decimal | null;
  macdHistogram: Decimal | null;
  bollingerUpper: Decimal | null;
  bollingerMiddle: Decimal | null;
  bollingerLower: Decimal | null;
  atr14: Decimal | null;
  vwap: Decimal | null;
  stochasticK: Decimal | null;
  stochasticD: Decimal | null;
  obv: Decimal;
  /** Bars loaded. A short history is why a value may be null. */
  barsAvailable: number;
}

/**
 * Per-bar values for every indicator the scanner and charts can reference.
 *
 * `close` and `volume` are included so a condition can compare an indicator to
 * price without the caller having to carry the candles alongside this object.
 */
export interface IndicatorSeries {
  length: number;
  openTime: Date[];
  close: (Decimal | null)[];
  volume: (Decimal | null)[];
  sma20: (Decimal | null)[];
  sma50: (Decimal | null)[];
  ema12: (Decimal | null)[];
  ema26: (Decimal | null)[];
  rsi14: (Decimal | null)[];
  macd: (Decimal | null)[];
  macdSignal: (Decimal | null)[];
  macdHistogram: (Decimal | null)[];
  bollingerUpper: (Decimal | null)[];
  bollingerMiddle: (Decimal | null)[];
  bollingerLower: (Decimal | null)[];
  atr14: (Decimal | null)[];
  vwap: (Decimal | null)[];
  stochasticK: (Decimal | null)[];
  stochasticD: (Decimal | null)[];
}

export class IndicatorService {
  constructor(private readonly db: PrismaClient) {}

  /**
   * Loads candles for a symbol, oldest first.
   *
   * `limit` counts back from the newest bar, so callers get the most recent
   * window rather than the beginning of history — but the array is returned in
   * ascending order, because every indicator expects it that way.
   */
  async loadCandles(
    symbol: string,
    timeframe: Timeframe,
    options: { limit?: number; from?: Date; to?: Date } = {},
  ): Promise<ProviderCandle[]> {
    const rows = await this.db.marketDataCandle.findMany({
      where: {
        symbol,
        timeframe,
        ...(options.from || options.to
          ? {
              openTime: {
                ...(options.from && { gte: options.from }),
                ...(options.to && { lte: options.to }),
              },
            }
          : {}),
      },
      orderBy: { openTime: 'desc' },
      take: options.limit ?? 500,
    });

    return rows.reverse().map((row) => ({
      symbol: row.symbol,
      timeframe: row.timeframe as Timeframe,
      openTime: row.openTime,
      closeTime: row.closeTime,
      open: dec(row.open.toString()),
      high: dec(row.high.toString()),
      low: dec(row.low.toString()),
      close: dec(row.close.toString()),
      volume: dec(row.volume.toString()),
      vwap: row.vwap === null ? null : dec(row.vwap.toString()),
      tradeCount: row.tradeCount,
      isAdjusted: row.isAdjusted,
    }));
  }

  /**
   * Every indicator as of the most recent stored bar.
   *
   * Returns null when there are no candles at all — distinct from a snapshot
   * whose individual values are null because the history is too short to
   * define them. The caller can tell "no data" from "not enough data yet".
   */
  async snapshot(
    symbol: string,
    timeframe: Timeframe,
    options: { limit?: number } = {},
  ): Promise<IndicatorSnapshot | null> {
    const candles = await this.loadCandles(symbol, timeframe, options);
    return this.snapshotFrom(symbol, timeframe, candles);
  }

  /**
   * Full per-bar series, for charting.
   *
   * Distinct from `snapshot`, which is the newest bar only. Every array comes
   * back the same length as the candles it was computed from, so a chart can
   * index straight into it — and the nulls are warm-up, which a chart must draw
   * as a break in the line rather than a drop to zero.
   */
  async series(
    symbol: string,
    timeframe: Timeframe,
    options: { limit?: number } = {},
  ): Promise<IndicatorSeries> {
    const candles = await this.loadCandles(symbol, timeframe, options);
    return this.seriesFrom(candles);
  }

  /** The same computation over candles the caller already holds. */
  seriesFrom(candles: ProviderCandle[]): IndicatorSeries {
    const prices = closes(candles);
    const bands = bollinger(prices);
    const macdPoints = macd(prices);
    const stochasticPoints = stochastic(candles);

    return {
      length: candles.length,
      openTime: candles.map((c) => c.openTime),
      close: prices,
      volume: candles.map((c) => c.volume),
      sma20: sma(prices, 20),
      sma50: sma(prices, 50),
      ema12: ema(prices, 12),
      ema26: ema(prices, 26),
      rsi14: rsi(prices, 14),
      macd: macdPoints.map((p) => p.macd),
      macdSignal: macdPoints.map((p) => p.signal),
      macdHistogram: macdPoints.map((p) => p.histogram),
      bollingerUpper: bands.map((b) => b.upper),
      bollingerMiddle: bands.map((b) => b.middle),
      bollingerLower: bands.map((b) => b.lower),
      atr14: atr(candles, 14),
      vwap: vwap(candles),
      stochasticK: stochasticPoints.map((p) => p.k),
      stochasticD: stochasticPoints.map((p) => p.d),
    };
  }

  /** The same computation over candles the caller already holds. */
  snapshotFrom(
    symbol: string,
    timeframe: Timeframe,
    candles: ProviderCandle[],
  ): IndicatorSnapshot | null {
    const last = candles.length - 1;
    const latest = candles[last];
    if (!latest) return null;

    const prices = closes(candles);
    const macdPoints = macd(prices);
    const bands = bollinger(prices);
    const stochasticPoints = stochastic(candles);

    const at = <T>(values: (T | null)[]): T | null => values[last] ?? null;

    return {
      symbol,
      timeframe,
      asOf: latest.openTime,
      close: latest.close,
      sma20: at(sma(prices, 20)),
      sma50: at(sma(prices, 50)),
      ema12: at(ema(prices, 12)),
      ema26: at(ema(prices, 26)),
      rsi14: at(rsi(prices, 14)),
      macd: macdPoints[last]?.macd ?? null,
      macdSignal: macdPoints[last]?.signal ?? null,
      macdHistogram: macdPoints[last]?.histogram ?? null,
      bollingerUpper: bands[last]?.upper ?? null,
      bollingerMiddle: bands[last]?.middle ?? null,
      bollingerLower: bands[last]?.lower ?? null,
      atr14: at(atr(candles, 14)),
      vwap: at(vwap(candles)),
      stochasticK: stochasticPoints[last]?.k ?? null,
      stochasticD: stochasticPoints[last]?.d ?? null,
      obv: obv(candles)[last] ?? dec(0),
      barsAvailable: candles.length,
    };
  }
}
