import { dec, type Decimal } from '@zusu/shared';
import {
  TIMEFRAME_MINUTES,
  type ProviderCandle,
  type ProviderQuote,
  type Timeframe,
} from './types.js';

/**
 * Market-data quality detection (§6).
 *
 * Pure functions over data the provider has already returned: no database, no
 * clock of their own, no network. Everything they need is passed in, which is
 * what makes the thresholds testable at their exact boundaries.
 *
 * The premise is that bad data is normal. Feeds freeze, repeat themselves,
 * cross the book, drop bars and print the occasional impossible tick. A
 * platform that trades on whatever arrives will eventually act on one of those,
 * so every finding here carries a `blocking` verdict and the service layer
 * turns a blocking finding into a refusal to trade.
 */

/** Mirrors the `DataQualityIssue` enum in the Prisma schema. */
export const DataQualityIssue = {
  STALE_QUOTE: 'STALE_QUOTE',
  MISSING_CANDLE: 'MISSING_CANDLE',
  ABNORMAL_JUMP: 'ABNORMAL_JUMP',
  DUPLICATE: 'DUPLICATE',
  TIMESTAMP_GAP: 'TIMESTAMP_GAP',
  IMPOSSIBLE_SPREAD: 'IMPOSSIBLE_SPREAD',
  NON_POSITIVE_PRICE: 'NON_POSITIVE_PRICE',
  PROVIDER_OUTAGE: 'PROVIDER_OUTAGE',
} as const;
export type DataQualityIssue = (typeof DataQualityIssue)[keyof typeof DataQualityIssue];

export interface QualityFinding {
  issue: DataQualityIssue;
  symbol: string | null;
  detail: string;
  /**
   * True when this finding must stop new trades. A blocking finding is never
   * downgraded by the caller — the point of recording it is that something
   * refuses to act on it.
   */
  blocking: boolean;
}

export interface QualityThresholds {
  /** A quote whose provider clock is older than this is stale. */
  maxQuoteAgeMs: number;
  /** Spread wider than this fraction of the midpoint is treated as impossible. */
  maxSpreadFraction: Decimal;
  /** A move larger than this fraction against the reference price is abnormal. */
  maxJumpFraction: Decimal;
}

/**
 * Deliberately conservative. A threshold that is too tight blocks trading on
 * data that was merely unusual; one that is too loose lets a bad tick through.
 * The first failure mode is recoverable and the second is not, so these lean
 * tight, and every one of them is overridable per call.
 */
export const DEFAULT_THRESHOLDS: QualityThresholds = {
  // Three seconds. A real-time feed that has said nothing for longer than this
  // during a session is not keeping up, whatever its status page claims.
  maxQuoteAgeMs: 3_000,
  // 5% of the midpoint. Wider than this is either a crossed book, a halt, or a
  // symbol too illiquid to trade on a quote.
  maxSpreadFraction: dec('0.05'),
  // 20% against the reference price. A genuine move that large is halted long
  // before a strategy should act on it unaided.
  maxJumpFraction: dec('0.20'),
};

export interface QuoteInspection {
  /** The price the quote asserts, once it has been judged usable. */
  usablePrice: Decimal | null;
  findings: QualityFinding[];
}

/**
 * Judges a single quote.
 *
 * `referencePrice` is the last price this process trusted for the symbol, used
 * for jump detection. Omit it on the first quote: an abnormal jump cannot be
 * defined without something to jump from, and inventing a reference would
 * manufacture a finding.
 */
export function inspectQuote(
  quote: ProviderQuote,
  options: {
    referencePrice?: Decimal | null;
    thresholds?: Partial<QualityThresholds>;
  } = {},
): QuoteInspection {
  const thresholds = { ...DEFAULT_THRESHOLDS, ...options.thresholds };
  const findings: QualityFinding[] = [];
  const symbol = quote.symbol;

  const add = (issue: DataQualityIssue, detail: string, blocking = true) =>
    findings.push({ issue, symbol, detail, blocking });

  // Staleness is measured provider-clock against our clock. Using our clock for
  // both would make a frozen feed look perfectly fresh.
  const ageMs = quote.receivedTimestamp.getTime() - quote.sourceTimestamp.getTime();
  if (ageMs > thresholds.maxQuoteAgeMs) {
    add(
      DataQualityIssue.STALE_QUOTE,
      `quote is ${ageMs}ms old, over the ${thresholds.maxQuoteAgeMs}ms limit`,
    );
  }
  if (ageMs < -1_000) {
    // A source timestamp in our future means the clocks disagree, and every
    // staleness verdict computed from it is meaningless.
    add(
      DataQualityIssue.TIMESTAMP_GAP,
      `source timestamp is ${Math.abs(ageMs)}ms in the future; clocks disagree`,
    );
  }

  for (const [label, value] of [
    ['price', quote.price],
    ['bid', quote.bid],
    ['ask', quote.ask],
  ] as const) {
    if (value !== null && value.lte(0)) {
      add(DataQualityIssue.NON_POSITIVE_PRICE, `${label} is ${value.toString()}`);
    }
  }

  const { bid, ask } = quote;
  if (bid !== null && ask !== null && bid.gt(0) && ask.gt(0)) {
    if (bid.gt(ask)) {
      add(
        DataQualityIssue.IMPOSSIBLE_SPREAD,
        `book is crossed: bid ${bid.toString()} above ask ${ask.toString()}`,
      );
    } else {
      const midpoint = bid.plus(ask).div(2);
      const fraction = ask.minus(bid).div(midpoint);
      if (fraction.gt(thresholds.maxSpreadFraction)) {
        add(
          DataQualityIssue.IMPOSSIBLE_SPREAD,
          `spread is ${fraction.times(100).toFixed(2)}% of the midpoint, over the ` +
            `${thresholds.maxSpreadFraction.times(100).toFixed(2)}% limit`,
        );
      }
    }
  }

  const reference = options.referencePrice ?? null;
  if (quote.price !== null && quote.price.gt(0) && reference !== null && reference.gt(0)) {
    const move = quote.price.minus(reference).abs().div(reference);
    if (move.gt(thresholds.maxJumpFraction)) {
      add(
        DataQualityIssue.ABNORMAL_JUMP,
        `price moved ${move.times(100).toFixed(2)}% from ${reference.toString()} to ` +
          `${quote.price.toString()}, over the ${thresholds.maxJumpFraction.times(100).toFixed(2)}% limit`,
      );
    }
  }

  // A price is usable only when nothing blocking was found. Returning it
  // alongside the findings keeps the caller from having to re-derive the
  // verdict and accidentally disagreeing with it.
  const blocked = findings.some((f) => f.blocking);
  return {
    usablePrice: blocked ? null : quote.price,
    findings,
  };
}

export interface CandleInspection {
  /** Candles safe to store: de-duplicated, ordered, individually coherent. */
  usable: ProviderCandle[];
  findings: QualityFinding[];
}

/**
 * Judges a candle series.
 *
 * Session awareness is the caller's to supply. Without it, an overnight or
 * weekend break is indistinguishable from a dropped bar, so gap detection is
 * limited to holes *within a single UTC day* on intraday timeframes — a
 * deliberate under-report rather than a stream of false alarms. Pass
 * `isSessionGap` once the market-calendar engine exists (Phase 2 step 4) to
 * have every gap judged properly.
 */
export function inspectCandles(
  candles: ProviderCandle[],
  options: {
    /** Returns true when no bar is expected between these two times. */
    isSessionGap?: (from: Date, to: Date) => boolean;
  } = {},
): CandleInspection {
  const findings: QualityFinding[] = [];
  const first = candles[0];
  if (!first) {
    return { usable: [], findings };
  }

  const symbol = first.symbol;
  const timeframe = first.timeframe;
  const add = (issue: DataQualityIssue, detail: string, blocking = true) =>
    findings.push({ issue, symbol, detail, blocking });

  const coherent: ProviderCandle[] = [];
  for (const candle of candles) {
    const bad: string[] = [];

    for (const [label, value] of [
      ['open', candle.open],
      ['high', candle.high],
      ['low', candle.low],
      ['close', candle.close],
    ] as const) {
      if (value.lte(0)) bad.push(`${label} is ${value.toString()}`);
    }
    if (candle.volume.lt(0)) bad.push(`volume is ${candle.volume.toString()}`);

    if (bad.length > 0) {
      add(
        DataQualityIssue.NON_POSITIVE_PRICE,
        `bar at ${candle.openTime.toISOString()}: ${bad.join(', ')}`,
      );
      continue;
    }

    // An inverted high/low, or a body outside its own range, is the candle
    // equivalent of a crossed book: the bar cannot be true as printed.
    const incoherent: string[] = [];
    if (candle.high.lt(candle.low)) {
      incoherent.push(`high ${candle.high.toString()} below low ${candle.low.toString()}`);
    }
    if (candle.open.gt(candle.high) || candle.open.lt(candle.low)) {
      incoherent.push(`open ${candle.open.toString()} outside the high/low range`);
    }
    if (candle.close.gt(candle.high) || candle.close.lt(candle.low)) {
      incoherent.push(`close ${candle.close.toString()} outside the high/low range`);
    }

    if (incoherent.length > 0) {
      add(
        DataQualityIssue.IMPOSSIBLE_SPREAD,
        `bar at ${candle.openTime.toISOString()}: ${incoherent.join(', ')}`,
      );
      continue;
    }

    coherent.push(candle);
  }

  // Order before comparing neighbours; a provider that returns bars out of
  // order is a finding in itself, not a reason to mis-read every gap after it.
  const sorted = [...coherent].sort((a, b) => a.openTime.getTime() - b.openTime.getTime());
  const outOfOrder = coherent.some((c, i) => c !== sorted[i]);
  if (outOfOrder) {
    add(
      DataQualityIssue.TIMESTAMP_GAP,
      'bars were not returned in chronological order and have been re-sorted',
      false,
    );
  }

  const usable: ProviderCandle[] = [];
  const seen = new Map<number, ProviderCandle>();
  for (const candle of sorted) {
    const key = candle.openTime.getTime();
    const previous = seen.get(key);
    if (previous) {
      // An exact repeat is harmless once de-duplicated. A repeat that disagrees
      // with itself is not: nothing here can tell which of the two is true.
      const identical =
        previous.open.eq(candle.open) &&
        previous.high.eq(candle.high) &&
        previous.low.eq(candle.low) &&
        previous.close.eq(candle.close) &&
        previous.volume.eq(candle.volume);
      add(
        DataQualityIssue.DUPLICATE,
        identical
          ? `bar at ${candle.openTime.toISOString()} was sent twice identically and de-duplicated`
          : `bar at ${candle.openTime.toISOString()} was sent twice with different values`,
        !identical,
      );
      continue;
    }
    seen.set(key, candle);
    usable.push(candle);
  }

  const intervalMs = TIMEFRAME_MINUTES[timeframe as Timeframe] * 60_000;
  for (let i = 1; i < usable.length; i += 1) {
    const previous = usable[i - 1];
    const current = usable[i];
    if (!previous || !current) continue;
    const deltaMs = current.openTime.getTime() - previous.openTime.getTime();
    if (deltaMs <= intervalMs) continue;

    if (options.isSessionGap) {
      if (options.isSessionGap(previous.openTime, current.openTime)) continue;
    } else if (timeframe === '1d' || !sameUtcDay(previous.openTime, current.openTime)) {
      // No calendar available: only same-day intraday holes are certain.
      continue;
    }

    const missing = Math.round(deltaMs / intervalMs) - 1;
    add(
      DataQualityIssue.MISSING_CANDLE,
      `${missing} ${timeframe} bar(s) missing between ${previous.openTime.toISOString()} and ` +
        `${current.openTime.toISOString()}`,
    );
  }

  return { usable, findings };
}

/** A provider that cannot be reached at all. Always blocking. */
export function providerOutageFinding(provider: string, detail: string): QualityFinding {
  return {
    issue: DataQualityIssue.PROVIDER_OUTAGE,
    symbol: null,
    detail: `${provider} is unreachable: ${detail}`,
    blocking: true,
  };
}

function sameUtcDay(a: Date, b: Date): boolean {
  return (
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth() &&
    a.getUTCDate() === b.getUTCDate()
  );
}
