import { dec } from '@zusu/shared';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { IndicatorService } from '../../src/modules/market-data/indicator.service.js';
import { MarketDataQualityService } from '../../src/modules/market-data/quality.service.js';
import type { ProviderCandle } from '../../src/modules/market-data/types.js';
import { disconnectTestDb, resetDatabase, testDb } from '../helpers/db.js';

const db = testDb();
let indicators: IndicatorService;
let quality: MarketDataQualityService;

/**
 * Minute bars from 14:30Z, closing at the given prices.
 *
 * High and low straddle the close so every bar is coherent — the quality layer
 * is on the ingestion path and will drop a bar whose close sits outside its own
 * range, or whose low is non-positive.
 */
function series(closePrices: number[]): ProviderCandle[] {
  return closePrices.map((close, i) => {
    const openTime = new Date(Date.UTC(2026, 6, 15, 14, 30 + i));
    return {
      symbol: 'AAPL',
      timeframe: '1m' as const,
      openTime,
      closeTime: new Date(openTime.getTime() + 60_000),
      open: dec(close),
      high: dec(close + 1),
      low: dec(close - 1),
      close: dec(close),
      volume: dec(1_000),
      vwap: null,
      tradeCount: 10,
      isAdjusted: true,
    };
  });
}

beforeEach(async () => {
  await resetDatabase();
  indicators = new IndicatorService(db);
  quality = new MarketDataQualityService(db);
  await db.instrument.create({ data: { symbol: 'AAPL', name: 'Apple', exchange: 'XNYS' } });
});

afterAll(async () => {
  await disconnectTestDb();
});

describe('loadCandles', () => {
  it('returns bars oldest first, whatever order they were stored in', async () => {
    // Stored newest-first to prove the ordering is not incidental.
    const bars = series([10, 11, 12, 13]);
    for (const bar of [...bars].reverse()) {
      await quality.ingestCandles([bar], { provider: 'test' });
    }

    const loaded = await indicators.loadCandles('AAPL', '1m');
    expect(loaded.map((c) => c.close.toString())).toEqual(['10', '11', '12', '13']);
  });

  it('takes the most recent window when limited, still ascending', async () => {
    await quality.ingestCandles(series([11, 12, 13, 14, 15, 16, 17, 18]), { provider: 'test' });

    const loaded = await indicators.loadCandles('AAPL', '1m', { limit: 3 });
    // The newest three, in ascending order — not the oldest three.
    expect(loaded.map((c) => c.close.toString())).toEqual(['16', '17', '18']);
  });

  it('filters by a date range', async () => {
    await quality.ingestCandles(series([11, 12, 13, 14, 15]), { provider: 'test' });

    const loaded = await indicators.loadCandles('AAPL', '1m', {
      from: new Date(Date.UTC(2026, 6, 15, 14, 31)),
      to: new Date(Date.UTC(2026, 6, 15, 14, 33)),
    });
    expect(loaded.map((c) => c.close.toString())).toEqual(['12', '13', '14']);
  });

  it('does not mix timeframes', async () => {
    await quality.ingestCandles(series([10, 11, 12]), { provider: 'test' });
    const hourly = series([100, 101]).map((c) => ({ ...c, timeframe: '1h' as const }));
    await quality.ingestCandles(hourly, { provider: 'test' });

    expect(await indicators.loadCandles('AAPL', '1m')).toHaveLength(3);
    expect(await indicators.loadCandles('AAPL', '1h')).toHaveLength(2);
  });

  it('preserves decimal precision through the database round trip', async () => {
    const bar = series([10])[0] as ProviderCandle;
    await quality.ingestCandles(
      [
        {
          ...bar,
          open: dec('123.5'),
          close: dec('123.45678901'),
          high: dec('124'),
          low: dec('123'),
        },
      ],
      { provider: 'test' },
    );

    const [loaded] = await indicators.loadCandles('AAPL', '1m');
    expect(loaded?.close.toString()).toBe('123.45678901');
  });

  it('returns nothing for an unknown symbol', async () => {
    expect(await indicators.loadCandles('NOPE', '1m')).toEqual([]);
  });
});

describe('snapshot', () => {
  it('returns null when there are no candles at all', async () => {
    // Distinct from a snapshot whose values are null for want of history.
    expect(await indicators.snapshot('AAPL', '1m')).toBeNull();
  });

  it('reports which values are undefined on a short history', async () => {
    await quality.ingestCandles(series([10, 11, 12, 13, 14]), { provider: 'test' });
    const snap = await indicators.snapshot('AAPL', '1m');

    expect(snap).not.toBeNull();
    expect(snap?.barsAvailable).toBe(5);
    // Five bars cannot define a 20-period average. Null, not zero and not a
    // partial figure computed off whatever happens to be there.
    expect(snap?.sma20).toBeNull();
    expect(snap?.rsi14).toBeNull();
    expect(snap?.atr14).toBeNull();
    // OBV is cumulative from bar one, so it always has a value.
    expect(snap?.obv).not.toBeNull();
    expect(snap?.close.toString()).toBe('14');
  });

  it('fills in every indicator once the history is long enough', async () => {
    const prices = Array.from({ length: 80 }, (_, i) => 100 + Math.sin(i / 4) * 8);
    await quality.ingestCandles(series(prices), { provider: 'test' });

    const snap = await indicators.snapshot('AAPL', '1m');
    expect(snap?.barsAvailable).toBe(80);
    for (const key of [
      'sma20',
      'sma50',
      'ema12',
      'ema26',
      'rsi14',
      'macd',
      'macdSignal',
      'macdHistogram',
      'bollingerUpper',
      'bollingerMiddle',
      'bollingerLower',
      'atr14',
      'vwap',
      'stochasticK',
      'stochasticD',
    ] as const) {
      expect(snap?.[key], key).not.toBeNull();
    }
  });

  it('is as of the newest bar', async () => {
    await quality.ingestCandles(series([10, 11, 12]), { provider: 'test' });
    const snap = await indicators.snapshot('AAPL', '1m');

    expect(snap?.asOf.toISOString()).toBe('2026-07-15T14:32:00.000Z');
    expect(snap?.close.toString()).toBe('12');
  });

  it('agrees with the pure functions computed over the same bars', async () => {
    const prices = Array.from({ length: 60 }, (_, i) => 100 + (i % 5));
    const bars = series(prices);
    await quality.ingestCandles(bars, { provider: 'test' });

    const fromDb = await indicators.snapshot('AAPL', '1m');
    const fromMemory = indicators.snapshotFrom('AAPL', '1m', bars);

    expect(fromDb?.sma20?.toString()).toBe(fromMemory?.sma20?.toString());
    expect(fromDb?.rsi14?.toString()).toBe(fromMemory?.rsi14?.toString());
    expect(fromDb?.atr14?.toString()).toBe(fromMemory?.atr14?.toString());
    expect(fromDb?.obv.toString()).toBe(fromMemory?.obv.toString());
  });

  it('is unaffected by bars the quality layer rejected', async () => {
    const bars = series([10, 11, 12, 13, 14]);
    // An impossible bar in the middle: dropped at ingestion, so it cannot
    // reach an indicator at all.
    const corrupted = [...bars];
    corrupted[2] = { ...(bars[2] as ProviderCandle), high: dec('1'), low: dec('99') };

    await quality.ingestCandles(corrupted, { provider: 'test' });
    const snap = await indicators.snapshot('AAPL', '1m');

    expect(snap?.barsAvailable).toBe(4);
    expect(await db.marketDataCandle.count()).toBe(4);
  });

  it('respects the bar limit, so a snapshot is a window not all of history', async () => {
    await quality.ingestCandles(series(Array.from({ length: 100 }, (_, i) => 100 + i)), {
      provider: 'test',
    });

    const windowed = await indicators.snapshot('AAPL', '1m', { limit: 30 });
    expect(windowed?.barsAvailable).toBe(30);
    // A 50-period average cannot exist in a 30-bar window.
    expect(windowed?.sma50).toBeNull();
    expect(windowed?.sma20).not.toBeNull();
  });
});
