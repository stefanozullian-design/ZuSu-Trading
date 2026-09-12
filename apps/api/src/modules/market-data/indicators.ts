import { Decimal, dec } from '@zusu/shared';
import type { ProviderCandle } from './types.js';

/**
 * The indicator engine (§8).
 *
 * Computed locally, in decimal, never fetched from a provider. Three rules the
 * whole module obeys, and which the tests check rather than assume:
 *
 *   1. **Alignment.** Every function returns an array the same length as its
 *      input, so `result[i]` is always the value as of `input[i]`. Callers
 *      never have to reason about an offset.
 *
 *   2. **No look-ahead.** `result[i]` depends only on inputs at or before `i`.
 *      This is the property Phase 4's backtester lives or dies by: an
 *      indicator that peeks one bar ahead turns a losing strategy into a
 *      spectacular backtest and a disaster in production. Every indicator has
 *      a test proving that computing over a prefix gives the same values as
 *      computing over the whole series and truncating.
 *
 *   3. **Warm-up is null, never zero.** An indicator without enough data to be
 *      defined returns null. Zero is a number a strategy would act on; null is
 *      a value it must handle. A 14-period RSI on ten bars is not 0, and it is
 *      not 50 either — it does not exist yet.
 *
 * Float is avoided throughout. It is not that a cent of drift in an RSI
 * matters, but that these values feed position sizing and stop placement,
 * where it does, and mixing representations is how that drift gets in.
 */

/** Wilder's smoothing, used by RSI, ATR and ADX. Not the same as an EMA. */
function wilderNext(previous: Decimal, current: Decimal, period: number): Decimal {
  return previous
    .times(period - 1)
    .plus(current)
    .div(period);
}

function assertPeriod(period: number, name: string): void {
  if (!Number.isInteger(period) || period < 1) {
    throw new Error(`${name} period must be a positive integer, got ${String(period)}`);
  }
}

/** Filled with nulls, so every function starts aligned and stays aligned. */
function nulls<T>(length: number): (T | null)[] {
  return new Array<T | null>(length).fill(null);
}

/**
 * Simple moving average.
 *
 * Computed with a running sum rather than re-adding the window each step, so a
 * long series stays linear. Exact in decimal either way.
 */
export function sma(values: Decimal[], period: number): (Decimal | null)[] {
  assertPeriod(period, 'sma');
  const out = nulls<Decimal>(values.length);
  if (values.length < period) return out;

  let sum = dec(0);
  for (let i = 0; i < values.length; i += 1) {
    sum = sum.plus(values[i] as Decimal);
    if (i >= period) sum = sum.minus(values[i - period] as Decimal);
    if (i >= period - 1) out[i] = sum.div(period);
  }
  return out;
}

/**
 * Exponential moving average.
 *
 * Seeded with the simple average of the first `period` values — the
 * conventional choice, and the one that makes the first defined value land at
 * index `period - 1` rather than at index 0 with a wildly wrong figure.
 */
export function ema(values: Decimal[], period: number): (Decimal | null)[] {
  assertPeriod(period, 'ema');
  const out = nulls<Decimal>(values.length);
  if (values.length < period) return out;

  const multiplier = dec(2).div(period + 1);
  let sum = dec(0);
  for (let i = 0; i < period; i += 1) sum = sum.plus(values[i] as Decimal);
  let previous = sum.div(period);
  out[period - 1] = previous;

  for (let i = period; i < values.length; i += 1) {
    const value = values[i] as Decimal;
    previous = value.minus(previous).times(multiplier).plus(previous);
    out[i] = previous;
  }
  return out;
}

/**
 * Relative strength index, Wilder's original formulation.
 *
 * The two saturating cases are handled explicitly rather than left to divide
 * by zero: with no losses in the window RSI is 100, and with no gains it is 0.
 */
export function rsi(values: Decimal[], period = 14): (Decimal | null)[] {
  assertPeriod(period, 'rsi');
  const out = nulls<Decimal>(values.length);
  if (values.length <= period) return out;

  let gainSum = dec(0);
  let lossSum = dec(0);
  for (let i = 1; i <= period; i += 1) {
    const change = (values[i] as Decimal).minus(values[i - 1] as Decimal);
    if (change.gt(0)) gainSum = gainSum.plus(change);
    else lossSum = lossSum.plus(change.abs());
  }

  let avgGain = gainSum.div(period);
  let avgLoss = lossSum.div(period);
  out[period] = rsiFrom(avgGain, avgLoss);

  for (let i = period + 1; i < values.length; i += 1) {
    const change = (values[i] as Decimal).minus(values[i - 1] as Decimal);
    const gain = change.gt(0) ? change : dec(0);
    const loss = change.lt(0) ? change.abs() : dec(0);
    avgGain = wilderNext(avgGain, gain, period);
    avgLoss = wilderNext(avgLoss, loss, period);
    out[i] = rsiFrom(avgGain, avgLoss);
  }
  return out;
}

function rsiFrom(avgGain: Decimal, avgLoss: Decimal): Decimal {
  if (avgLoss.isZero()) return avgGain.isZero() ? dec(50) : dec(100);
  if (avgGain.isZero()) return dec(0);
  const rs = avgGain.div(avgLoss);
  return dec(100).minus(dec(100).div(rs.plus(1)));
}

export interface MacdPoint {
  macd: Decimal | null;
  signal: Decimal | null;
  histogram: Decimal | null;
}

/**
 * MACD, its signal line and the histogram.
 *
 * The signal line is an EMA of the MACD line, which only exists from the slow
 * EMA's warm-up onward — so the signal is seeded from that shorter series and
 * lands `signalPeriod - 1` bars later still. Getting this wrong by aligning
 * the signal to the input instead is the classic MACD bug.
 */
export function macd(
  values: Decimal[],
  fastPeriod = 12,
  slowPeriod = 26,
  signalPeriod = 9,
): MacdPoint[] {
  assertPeriod(fastPeriod, 'macd fast');
  assertPeriod(slowPeriod, 'macd slow');
  assertPeriod(signalPeriod, 'macd signal');
  if (fastPeriod >= slowPeriod) {
    throw new Error('macd fast period must be shorter than the slow period');
  }

  const fast = ema(values, fastPeriod);
  const slow = ema(values, slowPeriod);
  const out: MacdPoint[] = values.map(() => ({ macd: null, signal: null, histogram: null }));

  const line: Decimal[] = [];
  const lineIndex: number[] = [];
  for (let i = 0; i < values.length; i += 1) {
    const f = fast[i];
    const s = slow[i];
    if (!f || !s) continue;
    const value = f.minus(s);
    (out[i] as MacdPoint).macd = value;
    line.push(value);
    lineIndex.push(i);
  }

  const signal = ema(line, signalPeriod);
  for (let j = 0; j < line.length; j += 1) {
    const value = signal[j];
    if (!value) continue;
    const i = lineIndex[j] as number;
    const point = out[i] as MacdPoint;
    point.signal = value;
    point.histogram = (point.macd as Decimal).minus(value);
  }
  return out;
}

/** Population standard deviation over a window, as Bollinger Bands use. */
export function standardDeviation(values: Decimal[], period: number): (Decimal | null)[] {
  assertPeriod(period, 'standardDeviation');
  const out = nulls<Decimal>(values.length);
  const means = sma(values, period);

  for (let i = period - 1; i < values.length; i += 1) {
    const mean = means[i];
    if (!mean) continue;
    let sumSquares = dec(0);
    for (let j = i - period + 1; j <= i; j += 1) {
      sumSquares = sumSquares.plus((values[j] as Decimal).minus(mean).pow(2));
    }
    out[i] = sumSquares.div(period).sqrt();
  }
  return out;
}

export interface BollingerPoint {
  upper: Decimal | null;
  middle: Decimal | null;
  lower: Decimal | null;
}

/** Bollinger Bands. The middle band is the SMA, by definition. */
export function bollinger(values: Decimal[], period = 20, deviations = 2): BollingerPoint[] {
  assertPeriod(period, 'bollinger');
  if (!(deviations > 0)) throw new Error('bollinger deviations must be positive');

  const middles = sma(values, period);
  const deviationsAt = standardDeviation(values, period);

  return values.map((_, i) => {
    const middle = middles[i];
    const sd = deviationsAt[i];
    if (!middle || !sd) return { upper: null, middle: null, lower: null };
    const offset = sd.times(deviations);
    return { upper: middle.plus(offset), middle, lower: middle.minus(offset) };
  });
}

/**
 * True range per bar.
 *
 * The first bar has no previous close, so its true range is simply high minus
 * low. Substituting a zero previous close would make the first range enormous.
 */
export function trueRange(candles: ProviderCandle[]): Decimal[] {
  return candles.map((candle, i) => {
    const highLow = candle.high.minus(candle.low);
    if (i === 0) return highLow;
    const previousClose = (candles[i - 1] as ProviderCandle).close;
    return Decimal.max(
      highLow,
      candle.high.minus(previousClose).abs(),
      candle.low.minus(previousClose).abs(),
    );
  });
}

/** Average true range, Wilder-smoothed. */
export function atr(candles: ProviderCandle[], period = 14): (Decimal | null)[] {
  assertPeriod(period, 'atr');
  const out = nulls<Decimal>(candles.length);
  if (candles.length < period) return out;

  const ranges = trueRange(candles);
  let sum = dec(0);
  for (let i = 0; i < period; i += 1) sum = sum.plus(ranges[i] as Decimal);
  let previous = sum.div(period);
  out[period - 1] = previous;

  for (let i = period; i < candles.length; i += 1) {
    previous = wilderNext(previous, ranges[i] as Decimal, period);
    out[i] = previous;
  }
  return out;
}

/**
 * Volume-weighted average price, anchored to a session.
 *
 * VWAP is meaningless across a session boundary — it is the day's average
 * price, not an all-time one — so it resets. `startsNewSession` decides where.
 * The default is a change of UTC date, which is right for crypto and wrong at
 * the edges for US equities; pass the market calendar's view for those. A
 * running VWAP of zero-volume bars stays null rather than dividing by zero.
 */
export function vwap(
  candles: ProviderCandle[],
  startsNewSession: (candle: ProviderCandle, previous: ProviderCandle) => boolean = differentUtcDay,
): (Decimal | null)[] {
  const out = nulls<Decimal>(candles.length);
  let cumulativeValue = dec(0);
  let cumulativeVolume = dec(0);

  for (let i = 0; i < candles.length; i += 1) {
    const candle = candles[i] as ProviderCandle;
    const previous = i > 0 ? (candles[i - 1] as ProviderCandle) : null;
    if (previous && startsNewSession(candle, previous)) {
      cumulativeValue = dec(0);
      cumulativeVolume = dec(0);
    }

    const typical = candle.high.plus(candle.low).plus(candle.close).div(3);
    cumulativeValue = cumulativeValue.plus(typical.times(candle.volume));
    cumulativeVolume = cumulativeVolume.plus(candle.volume);
    out[i] = cumulativeVolume.isZero() ? null : cumulativeValue.div(cumulativeVolume);
  }
  return out;
}

function differentUtcDay(candle: ProviderCandle, previous: ProviderCandle): boolean {
  return (
    candle.openTime.getUTCFullYear() !== previous.openTime.getUTCFullYear() ||
    candle.openTime.getUTCMonth() !== previous.openTime.getUTCMonth() ||
    candle.openTime.getUTCDate() !== previous.openTime.getUTCDate()
  );
}

export interface StochasticPoint {
  k: Decimal | null;
  d: Decimal | null;
}

/**
 * Stochastic oscillator.
 *
 * %K is where the close sits in the window's range; %D is an SMA of %K. A
 * window with no range at all (high equals low throughout) has no meaningful
 * position in it, so %K is 50 rather than a division by zero.
 */
export function stochastic(
  candles: ProviderCandle[],
  kPeriod = 14,
  dPeriod = 3,
): StochasticPoint[] {
  assertPeriod(kPeriod, 'stochastic %K');
  assertPeriod(dPeriod, 'stochastic %D');

  const kValues = nulls<Decimal>(candles.length);
  for (let i = kPeriod - 1; i < candles.length; i += 1) {
    let highest = (candles[i] as ProviderCandle).high;
    let lowest = (candles[i] as ProviderCandle).low;
    for (let j = i - kPeriod + 1; j <= i; j += 1) {
      const candle = candles[j] as ProviderCandle;
      if (candle.high.gt(highest)) highest = candle.high;
      if (candle.low.lt(lowest)) lowest = candle.low;
    }
    const range = highest.minus(lowest);
    kValues[i] = range.isZero()
      ? dec(50)
      : (candles[i] as ProviderCandle).close.minus(lowest).div(range).times(100);
  }

  // %D is an SMA of the defined %K values only, so it lands dPeriod-1 bars
  // after the first %K rather than being aligned to the raw input.
  const defined: Decimal[] = [];
  const definedIndex: number[] = [];
  for (let i = 0; i < kValues.length; i += 1) {
    const k = kValues[i];
    if (k) {
      defined.push(k);
      definedIndex.push(i);
    }
  }
  const dValues = sma(defined, dPeriod);

  const out: StochasticPoint[] = candles.map((_, i) => ({ k: kValues[i] ?? null, d: null }));
  for (let j = 0; j < defined.length; j += 1) {
    const d = dValues[j];
    if (d) (out[definedIndex[j] as number] as StochasticPoint).d = d;
  }
  return out;
}

/**
 * On-balance volume.
 *
 * Cumulative from the first bar, so unlike the others it has no warm-up: the
 * first bar's OBV is zero because nothing has happened yet, which is a real
 * value rather than a missing one.
 */
export function obv(candles: ProviderCandle[]): Decimal[] {
  const out: Decimal[] = [];
  let running = dec(0);
  for (let i = 0; i < candles.length; i += 1) {
    if (i > 0) {
      const candle = candles[i] as ProviderCandle;
      const previous = candles[i - 1] as ProviderCandle;
      if (candle.close.gt(previous.close)) running = running.plus(candle.volume);
      else if (candle.close.lt(previous.close)) running = running.minus(candle.volume);
    }
    out.push(running);
  }
  return out;
}

/** Closing prices, the usual input to a price-series indicator. */
export function closes(candles: ProviderCandle[]): Decimal[] {
  return candles.map((candle) => candle.close);
}
