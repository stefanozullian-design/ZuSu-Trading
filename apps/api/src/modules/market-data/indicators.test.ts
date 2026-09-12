import { Decimal, PRICE_DP, dec } from '@zusu/shared';
import { describe, expect, it } from 'vitest';
import {
  atr,
  bollinger,
  closes,
  ema,
  macd,
  obv,
  rsi,
  sma,
  standardDeviation,
  stochastic,
  trueRange,
  vwap,
} from './indicators.js';
import type { ProviderCandle } from './types.js';

const d = (values: (number | string)[]): Decimal[] => values.map((v) => dec(v));

/** Renders a result array for comparison, keeping nulls distinguishable. */
const shown = (values: (Decimal | null)[], dp = 4): (string | null)[] =>
  values.map((v) => (v === null ? null : v.toDecimalPlaces(dp).toString()));

function candle(
  openTime: string,
  values: { high: number; low: number; close: number; volume?: number },
): ProviderCandle {
  const open = new Date(openTime);
  return {
    symbol: 'TEST',
    timeframe: '1m',
    openTime: open,
    closeTime: new Date(open.getTime() + 60_000),
    open: dec(values.close),
    high: dec(values.high),
    low: dec(values.low),
    close: dec(values.close),
    volume: dec(values.volume ?? 1_000),
    vwap: null,
    tradeCount: null,
    isAdjusted: true,
  };
}

/** A flat series of identical bars — the basis of several invariance checks. */
function flatCandles(count: number, price = 10, spread = 1): ProviderCandle[] {
  return Array.from({ length: count }, (_, i) =>
    candle(new Date(Date.UTC(2026, 6, 15, 14, i)).toISOString(), {
      high: price + spread,
      low: price - spread,
      close: price,
    }),
  );
}

function risingCandles(count: number): ProviderCandle[] {
  return Array.from({ length: count }, (_, i) =>
    candle(new Date(Date.UTC(2026, 6, 15, 14, i)).toISOString(), {
      high: 100 + i + 1,
      low: 100 + i - 1,
      close: 100 + i,
    }),
  );
}

describe('sma', () => {
  it('matches a hand-computed window', () => {
    // (1+2+3)/3=2, (2+3+4)/3=3, (3+4+5)/3=4
    expect(shown(sma(d([1, 2, 3, 4, 5]), 3))).toEqual([null, null, '2', '3', '4']);
  });

  it('returns the constant for a constant series', () => {
    expect(shown(sma(d([7, 7, 7, 7]), 2))).toEqual([null, '7', '7', '7']);
  });

  it('is all null when there is not enough data', () => {
    expect(sma(d([1, 2]), 5)).toEqual([null, null]);
  });

  it('is the identity at period 1', () => {
    expect(shown(sma(d([3, 1, 4]), 1))).toEqual(['3', '1', '4']);
  });

  it('handles an empty series', () => {
    expect(sma([], 3)).toEqual([]);
  });

  it('stays exact over a long series, where a running sum could drift', () => {
    const values = d(Array.from({ length: 500 }, (_, i) => (i % 7) + 0.1));
    const result = sma(values, 7);
    // Every full window covers one of each residue, so the mean is constant.
    expect(result[499]?.toDecimalPlaces(10).toString()).toBe('3.1');
  });

  it('rejects a nonsense period', () => {
    expect(() => sma(d([1]), 0)).toThrow(/positive integer/);
    expect(() => sma(d([1]), 1.5)).toThrow(/positive integer/);
  });
});

describe('ema', () => {
  it('matches a hand-computed series', () => {
    // period 3 -> multiplier 0.5; seed = (1+2+3)/3 = 2
    //   i=3: (4-2)*0.5+2 = 3
    //   i=4: (5-3)*0.5+3 = 4
    expect(shown(ema(d([1, 2, 3, 4, 5]), 3))).toEqual([null, null, '2', '3', '4']);
  });

  it('returns the constant for a constant series', () => {
    expect(shown(ema(d([5, 5, 5, 5, 5]), 3))).toEqual([null, null, '5', '5', '5']);
  });

  it('first defined value sits at index period-1', () => {
    const result = ema(d([1, 2, 3, 4, 5, 6]), 4);
    expect(result.slice(0, 3)).toEqual([null, null, null]);
    expect(result[3]).not.toBeNull();
  });

  it('is all null when there is not enough data', () => {
    expect(ema(d([1, 2]), 5)).toEqual([null, null]);
  });

  it('weights recent values more than an SMA does', () => {
    // A step up: the EMA must sit above the SMA on the bar after the step.
    const values = d([10, 10, 10, 10, 20]);
    const fastEnd = ema(values, 4)[4] as Decimal;
    const slowEnd = sma(values, 4)[4] as Decimal;
    expect(fastEnd.gt(slowEnd)).toBe(true);
  });
});

describe('rsi', () => {
  it('matches a hand-computed Wilder series', () => {
    // [10,11,12,11,12,13], period 3. Changes: +1,+1,-1,+1,+1
    //   seed: gains 2, losses 1 -> avgGain 2/3, avgLoss 1/3, RS 2
    //         RSI = 100 - 100/3          = 66.6667
    //   i=4:  avgGain (2/3*2+1)/3 = 7/9, avgLoss (1/3*2+0)/3 = 2/9, RS 3.5
    //         RSI = 100 - 100/4.5        = 77.7778
    //   i=5:  avgGain (7/9*2+1)/3 = 23/27, avgLoss (2/9*2)/3 = 4/27, RS 5.75
    //         RSI = 100 - 100/6.75       = 85.1852
    expect(shown(rsi(d([10, 11, 12, 11, 12, 13]), 3))).toEqual([
      null,
      null,
      null,
      '66.6667',
      '77.7778',
      '85.1852',
    ]);
  });

  it('saturates at 100 for an unbroken rise', () => {
    // No losses at all — the divide-by-zero case, answered explicitly.
    const result = rsi(d([1, 2, 3, 4, 5, 6, 7, 8]), 3);
    expect(result[7]?.toString()).toBe('100');
  });

  it('saturates at 0 for an unbroken fall', () => {
    const result = rsi(d([8, 7, 6, 5, 4, 3, 2, 1]), 3);
    expect(result[7]?.toString()).toBe('0');
  });

  it('is 50 for a flat series, not 0 and not 100', () => {
    // Neither gains nor losses: the ambiguous case. 50 is the neutral answer.
    const result = rsi(d([5, 5, 5, 5, 5, 5]), 3);
    expect(result[5]?.toString()).toBe('50');
  });

  it('is 50 when average gain equals average loss', () => {
    // The seed averages the raw changes, so one up and one down gives 50.
    const result = rsi(d([10, 11, 10, 11, 10, 11, 10]), 2);
    expect(result[2]?.toString()).toBe('50');
  });

  it('does not return to 50 on an alternating series, because Wilder is asymmetric', () => {
    // Worth pinning down: smoothing weights recent bars, so an alternating
    // series does not oscillate around 50 — it lands wherever the last bar
    // pushed it. Hand-computed with avgGain/avgLoss at each step:
    //   i=2 seed 0.5/0.5   -> 50
    //   i=3      0.75/0.25 -> 75
    //   i=4      0.375/0.625   -> 37.5
    //   i=5      0.6875/0.3125 -> 68.75
    //   i=6      0.34375/0.65625 -> 34.375
    expect(shown(rsi(d([10, 11, 10, 11, 10, 11, 10]), 2))).toEqual([
      null,
      null,
      '50',
      '75',
      '37.5',
      '68.75',
      '34.375',
    ]);
  });

  it('stays within 0 and 100 on a noisy series', () => {
    const values = d([44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84, 46.08, 45.89]);
    for (const value of rsi(values, 5)) {
      if (!value) continue;
      expect(value.gte(0)).toBe(true);
      expect(value.lte(100)).toBe(true);
    }
  });

  it('needs period+1 values, since it works on changes', () => {
    // Three values give two changes, which is not enough for a 3-period RSI.
    expect(rsi(d([1, 2, 3]), 3)).toEqual([null, null, null]);
    expect(rsi(d([1, 2, 3, 4]), 3)[3]).not.toBeNull();
  });
});

describe('macd', () => {
  it('is zero throughout for a constant series', () => {
    const result = macd(d(Array.from({ length: 40 }, () => 100)));
    const last = result[39] as { macd: Decimal | null; signal: Decimal | null };
    expect(last.macd?.toString()).toBe('0');
    expect(last.signal?.toString()).toBe('0');
  });

  it('aligns the signal line to the MACD line, not to the input', () => {
    // fast 2, slow 3, signal 2 on ten bars:
    //   slow EMA defined from index 2 -> MACD defined from index 2
    //   signal is an EMA of that shorter line, so lands one bar later, index 3
    const result = macd(d([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), 2, 3, 2);
    expect(result[1]?.macd).toBeNull();
    expect(result[2]?.macd).not.toBeNull();
    expect(result[2]?.signal).toBeNull();
    expect(result[3]?.signal).not.toBeNull();
  });

  it('histogram is exactly macd minus signal wherever both exist', () => {
    const result = macd(d(Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i) * 5)));
    for (const point of result) {
      if (!point.macd || !point.signal) {
        expect(point.histogram).toBeNull();
        continue;
      }
      expect(point.histogram?.toString()).toBe(point.macd.minus(point.signal).toString());
    }
  });

  it('is positive when a fast rise pulls the fast EMA above the slow', () => {
    const values = d([
      ...Array.from({ length: 30 }, () => 100),
      ...Array.from({ length: 10 }, (_, i) => 100 + i * 5),
    ]);
    const result = macd(values);
    expect((result[39] as { macd: Decimal }).macd.gt(0)).toBe(true);
  });

  it('rejects a fast period that is not shorter than the slow one', () => {
    expect(() => macd(d([1, 2, 3]), 26, 12)).toThrow(/shorter than the slow/);
    expect(() => macd(d([1, 2, 3]), 12, 12)).toThrow(/shorter than the slow/);
  });
});

describe('standardDeviation', () => {
  it('matches a textbook population standard deviation', () => {
    // [2,4,4,4,5,5,7,9]: mean 5, squared deviations sum 32, 32/8 = 4, sqrt 2.
    const result = standardDeviation(d([2, 4, 4, 4, 5, 5, 7, 9]), 8);
    expect(result[7]?.toString()).toBe('2');
  });

  it('is zero for a constant window', () => {
    expect(standardDeviation(d([3, 3, 3, 3]), 4)[3]?.toString()).toBe('0');
  });
});

describe('bollinger', () => {
  it('matches a hand-computed band', () => {
    // Same textbook series: middle 5, sd 2, so 2 deviations gives 9 and 1.
    const [point] = bollinger(d([2, 4, 4, 4, 5, 5, 7, 9]), 8, 2).slice(7);
    expect(point?.middle?.toString()).toBe('5');
    expect(point?.upper?.toString()).toBe('9');
    expect(point?.lower?.toString()).toBe('1');
  });

  it('collapses onto the price for a constant series', () => {
    const [point] = bollinger(d([6, 6, 6, 6]), 4).slice(3);
    expect(point?.upper?.toString()).toBe('6');
    expect(point?.lower?.toString()).toBe('6');
  });

  it('middle band is exactly the SMA', () => {
    const values = d([12, 15, 11, 18, 20, 17, 13, 19, 22, 16]);
    const bands = bollinger(values, 4);
    const means = sma(values, 4);
    expect(shown(bands.map((b) => b.middle))).toEqual(shown(means));
  });

  it('brackets the middle symmetrically', () => {
    const values = d([12, 15, 11, 18, 20, 17, 13, 19, 22, 16]);
    for (const band of bollinger(values, 4)) {
      if (!band.middle || !band.upper || !band.lower) continue;
      const up = band.upper.minus(band.middle);
      const down = band.middle.minus(band.lower);
      // Compared at PRICE_DP rather than exactly: both bands come from one
      // offset, so they are symmetric by construction, but an irrational
      // standard deviation added and then subtracted does not round-trip
      // bit-for-bit at Decimal's 20 significant digits.
      expect(up.toDecimalPlaces(PRICE_DP).toString()).toBe(
        down.toDecimalPlaces(PRICE_DP).toString(),
      );
    }
  });

  it('rejects non-positive deviations', () => {
    expect(() => bollinger(d([1, 2]), 2, 0)).toThrow(/must be positive/);
  });
});

describe('trueRange', () => {
  it('uses high minus low for the first bar, which has no previous close', () => {
    const candles = [candle('2026-07-15T14:00:00Z', { high: 12, low: 10, close: 11 })];
    // A zero previous close would make this 12 instead of 2.
    expect(trueRange(candles)[0]?.toString()).toBe('2');
  });

  it('takes the widest of the three measures across a gap up', () => {
    const candles = [
      candle('2026-07-15T14:00:00Z', { high: 12, low: 10, close: 11 }),
      candle('2026-07-15T14:01:00Z', { high: 20, low: 19, close: 19.5 }),
    ];
    // high-low = 1, |high-prevClose| = 9, |low-prevClose| = 8 -> 9
    expect(trueRange(candles)[1]?.toString()).toBe('9');
  });
});

describe('atr', () => {
  it('equals the constant true range of a flat series', () => {
    // Every bar has high 11, low 9, close 10, so every true range is 2.
    expect(atr(flatCandles(20), 14)[19]?.toString()).toBe('2');
  });

  it('first defined value sits at index period-1', () => {
    const result = atr(flatCandles(20), 14);
    expect(result[12]).toBeNull();
    expect(result[13]?.toString()).toBe('2');
  });

  it('is all null when there is not enough data', () => {
    expect(atr(flatCandles(5), 14).every((v) => v === null)).toBe(true);
  });

  it('is never negative', () => {
    for (const value of atr(risingCandles(40), 14)) {
      if (value) expect(value.gte(0)).toBe(true);
    }
  });
});

describe('vwap', () => {
  it('equals the price when every bar trades at one price', () => {
    const candles = [
      candle('2026-07-15T14:00:00Z', { high: 100, low: 100, close: 100, volume: 5 }),
      candle('2026-07-15T14:01:00Z', { high: 100, low: 100, close: 100, volume: 9_999 }),
    ];
    expect(shown(vwap(candles))).toEqual(['100', '100']);
  });

  it('matches a hand-computed volume weighting', () => {
    // typical 10 on 100 shares, then typical 20 on 300:
    //   (10*100 + 20*300) / 400 = 7000/400 = 17.5
    const candles = [
      candle('2026-07-15T14:00:00Z', { high: 10, low: 10, close: 10, volume: 100 }),
      candle('2026-07-15T14:01:00Z', { high: 20, low: 20, close: 20, volume: 300 }),
    ];
    expect(shown(vwap(candles))).toEqual(['10', '17.5']);
  });

  it('resets at a session boundary', () => {
    const candles = [
      candle('2026-07-15T14:00:00Z', { high: 10, low: 10, close: 10, volume: 100 }),
      candle('2026-07-16T14:00:00Z', { high: 20, low: 20, close: 20, volume: 300 }),
    ];
    // A VWAP carried across the boundary would read 17.5 on the second bar.
    expect(shown(vwap(candles))).toEqual(['10', '20']);
  });

  it('honours a supplied session predicate', () => {
    const candles = [
      candle('2026-07-15T14:00:00Z', { high: 10, low: 10, close: 10, volume: 100 }),
      candle('2026-07-15T14:01:00Z', { high: 20, low: 20, close: 20, volume: 300 }),
    ];
    expect(shown(vwap(candles, () => true))).toEqual(['10', '20']);
  });

  it('is null rather than zero while no volume has traded', () => {
    const candles = [candle('2026-07-15T14:00:00Z', { high: 10, low: 10, close: 10, volume: 0 })];
    expect(vwap(candles)).toEqual([null]);
  });
});

describe('stochastic', () => {
  it('is 100 when the close is at the top of the window', () => {
    const candles = [
      candle('2026-07-15T14:00:00Z', { high: 12, low: 8, close: 9 }),
      candle('2026-07-15T14:01:00Z', { high: 12, low: 8, close: 10 }),
      candle('2026-07-15T14:02:00Z', { high: 12, low: 8, close: 12 }),
    ];
    expect(stochastic(candles, 3, 1)[2]?.k?.toString()).toBe('100');
  });

  it('is 0 when the close is at the bottom of the window', () => {
    const candles = [
      candle('2026-07-15T14:00:00Z', { high: 12, low: 8, close: 9 }),
      candle('2026-07-15T14:01:00Z', { high: 12, low: 8, close: 10 }),
      candle('2026-07-15T14:02:00Z', { high: 12, low: 8, close: 8 }),
    ];
    expect(stochastic(candles, 3, 1)[2]?.k?.toString()).toBe('0');
  });

  it('is 50 at the midpoint of the window', () => {
    const candles = [
      candle('2026-07-15T14:00:00Z', { high: 12, low: 8, close: 9 }),
      candle('2026-07-15T14:01:00Z', { high: 12, low: 8, close: 10 }),
      candle('2026-07-15T14:02:00Z', { high: 12, low: 8, close: 10 }),
    ];
    expect(stochastic(candles, 3, 1)[2]?.k?.toString()).toBe('50');
  });

  it('is 50 for a window with no range at all, not a division by zero', () => {
    const candles = Array.from({ length: 3 }, (_, i) =>
      candle(new Date(Date.UTC(2026, 6, 15, 14, i)).toISOString(), {
        high: 10,
        low: 10,
        close: 10,
      }),
    );
    expect(stochastic(candles, 3, 1)[2]?.k?.toString()).toBe('50');
  });

  it('aligns %D to the defined %K values', () => {
    const candles = risingCandles(10);
    const result = stochastic(candles, 3, 3);
    // %K from index 2, so %D two bars later at index 4.
    expect(result[2]?.k).not.toBeNull();
    expect(result[3]?.d).toBeNull();
    expect(result[4]?.d).not.toBeNull();
  });

  it('stays within 0 and 100', () => {
    for (const point of stochastic(risingCandles(30), 14, 3)) {
      if (point.k) {
        expect(point.k.gte(0)).toBe(true);
        expect(point.k.lte(100)).toBe(true);
      }
    }
  });
});

describe('obv', () => {
  it('accumulates volume on up bars and subtracts it on down bars', () => {
    const candles = [
      candle('2026-07-15T14:00:00Z', { high: 11, low: 9, close: 10, volume: 100 }),
      candle('2026-07-15T14:01:00Z', { high: 12, low: 10, close: 11, volume: 200 }),
      candle('2026-07-15T14:02:00Z', { high: 12, low: 9, close: 10, volume: 300 }),
      candle('2026-07-15T14:03:00Z', { high: 12, low: 9, close: 10, volume: 400 }),
    ];
    // 0, +200, -300, unchanged (flat close)
    expect(shown(obv(candles))).toEqual(['0', '200', '-100', '-100']);
  });

  it('starts at zero, which is a real value rather than a warm-up', () => {
    expect(obv(flatCandles(3)).map((v) => v.toString())).toEqual(['0', '0', '0']);
  });

  it('equals total volume for an unbroken rise', () => {
    const candles = risingCandles(5);
    // Four up bars at 1000 each; the first contributes nothing.
    expect(obv(candles)[4]?.toString()).toBe('4000');
  });
});

/**
 * The look-ahead suite.
 *
 * Every indicator is computed over the full series and then over each prefix
 * of it. If `result[i]` depended on any bar after `i`, the prefix result would
 * differ from the truncated full result — so agreement across every prefix is
 * a proof of causality, not a spot check.
 */
describe('no look-ahead bias', () => {
  const priceSeries = d([
    44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28,
    46.28, 46.0, 46.03, 46.41, 46.22, 45.64, 46.21, 46.25, 45.71, 46.45, 45.78, 45.35, 44.03, 44.18,
    44.22, 44.57, 43.42, 42.66, 43.13,
  ]);

  const candleSeries: ProviderCandle[] = priceSeries.map((close, i) =>
    candle(new Date(Date.UTC(2026, 6, 15, 14, i)).toISOString(), {
      high: close.plus(0.5).toNumber(),
      low: close.minus(0.5).toNumber(),
      close: close.toNumber(),
      volume: 1_000 + i * 10,
    }),
  );

  /** Asserts that every prefix agrees with the full computation. */
  function assertCausal(
    name: string,
    full: (string | null)[],
    compute: (length: number) => (string | null)[],
  ) {
    for (let length = 1; length <= full.length; length += 1) {
      expect(compute(length), `${name} at prefix length ${length}`).toEqual(full.slice(0, length));
    }
  }

  it('sma', () => {
    const full = shown(sma(priceSeries, 5));
    assertCausal('sma', full, (n) => shown(sma(priceSeries.slice(0, n), 5)));
  });

  it('ema', () => {
    const full = shown(ema(priceSeries, 5));
    assertCausal('ema', full, (n) => shown(ema(priceSeries.slice(0, n), 5)));
  });

  it('rsi', () => {
    const full = shown(rsi(priceSeries, 14));
    assertCausal('rsi', full, (n) => shown(rsi(priceSeries.slice(0, n), 14)));
  });

  it('standardDeviation', () => {
    const full = shown(standardDeviation(priceSeries, 5));
    assertCausal('sd', full, (n) => shown(standardDeviation(priceSeries.slice(0, n), 5)));
  });

  it('bollinger', () => {
    const flatten = (points: { upper: Decimal | null; lower: Decimal | null }[]) =>
      points.flatMap((p) => [
        p.upper ? p.upper.toDecimalPlaces(4).toString() : null,
        p.lower ? p.lower.toDecimalPlaces(4).toString() : null,
      ]);
    const full = flatten(bollinger(priceSeries, 5));
    for (let n = 1; n <= priceSeries.length; n += 1) {
      expect(flatten(bollinger(priceSeries.slice(0, n), 5))).toEqual(full.slice(0, n * 2));
    }
  });

  it('macd', () => {
    const flatten = (points: { macd: Decimal | null; signal: Decimal | null }[]) =>
      points.flatMap((p) => [
        p.macd ? p.macd.toDecimalPlaces(4).toString() : null,
        p.signal ? p.signal.toDecimalPlaces(4).toString() : null,
      ]);
    const full = flatten(macd(priceSeries, 3, 6, 3));
    for (let n = 1; n <= priceSeries.length; n += 1) {
      expect(flatten(macd(priceSeries.slice(0, n), 3, 6, 3))).toEqual(full.slice(0, n * 2));
    }
  });

  it('atr', () => {
    const full = shown(atr(candleSeries, 14));
    assertCausal('atr', full, (n) => shown(atr(candleSeries.slice(0, n), 14)));
  });

  it('trueRange', () => {
    const full = shown(trueRange(candleSeries));
    assertCausal('trueRange', full, (n) => shown(trueRange(candleSeries.slice(0, n))));
  });

  it('vwap', () => {
    const full = shown(vwap(candleSeries));
    assertCausal('vwap', full, (n) => shown(vwap(candleSeries.slice(0, n))));
  });

  it('obv', () => {
    const full = shown(obv(candleSeries));
    assertCausal('obv', full, (n) => shown(obv(candleSeries.slice(0, n))));
  });

  it('stochastic', () => {
    const flatten = (points: { k: Decimal | null; d: Decimal | null }[]) =>
      points.flatMap((p) => [
        p.k ? p.k.toDecimalPlaces(4).toString() : null,
        p.d ? p.d.toDecimalPlaces(4).toString() : null,
      ]);
    const full = flatten(stochastic(candleSeries, 5, 3));
    for (let n = 1; n <= candleSeries.length; n += 1) {
      expect(flatten(stochastic(candleSeries.slice(0, n), 5, 3))).toEqual(full.slice(0, n * 2));
    }
  });
});

describe('closes', () => {
  it('extracts the closing prices in order', () => {
    expect(shown(closes(risingCandles(3)))).toEqual(['100', '101', '102']);
  });
});
