import type { IndicatorSeries } from './indicator.service.js';
import {
  describeCondition,
  evaluateCondition,
  type ScanCondition,
  type ScanField,
} from './condition.js';

/**
 * The scanner (§9).
 *
 * A flat list of conditions, all of which must hold at the newest stored bar.
 * Flat on purpose: the nested AND/OR/NOT tree belongs to the strategy engine,
 * and the two share their leaves (`condition.ts`) rather than each defining
 * their own comparison rules.
 *
 * Three rules, all of which the tests check:
 *
 *   1. **A null never matches.** An indicator still in warm-up has no value, so
 *      it cannot satisfy `rsi14 < 30` — and it must not be quietly dropped
 *      either. Such a symbol is reported as `notEvaluable` with the field that
 *      was missing, so "no matches" can be told apart from "not enough data".
 *
 *   2. **Every match explains itself.** A result carries the value of each
 *      referenced field at the matching bar. A scanner that says only "AAPL"
 *      cannot be checked; one that says "AAPL, rsi14 28.4, close 184.2" can.
 *
 *   3. **Only closed bars are considered.** The scan evaluates the last bar in
 *      the series and never looks past it.
 */

export {
  SCAN_FIELDS,
  SCAN_OPERATORS,
  describeCondition,
  describeOperand,
  evaluateCondition,
} from './condition.js';
export type {
  ConditionVerdict,
  ScanCondition,
  ScanField,
  ScanOperand,
  ScanOperator,
} from './condition.js';

export interface ScanFilter {
  timeframe: string;
  conditions: ScanCondition[];
}

export interface ScanMatch {
  symbol: string;
  asOf: Date;
  /** Value of every field the conditions referenced, for auditability. */
  values: Record<string, string>;
}

export interface ScanSkip {
  symbol: string;
  reason: string;
  /** The field that had no value, when that is why. */
  missingField: ScanField | null;
}

export interface ScanOutcome {
  matches: ScanMatch[];
  /** Symbols that could not be judged, with why. Never silently dropped. */
  notEvaluable: ScanSkip[];
  /** Symbols evaluated successfully that simply did not match. */
  evaluated: number;
}

/**
 * Evaluates one symbol's series against a filter.
 *
 * Returns a match, or a skip explaining why no verdict was possible, or
 * neither for a clean non-match.
 */
export function evaluateSymbol(
  symbol: string,
  series: IndicatorSeries,
  conditions: ScanCondition[],
): { match: ScanMatch | null; skip: ScanSkip | null } {
  const last = series.length - 1;
  if (last < 0) {
    return {
      match: null,
      skip: { symbol, reason: 'no stored bars for this symbol', missingField: null },
    };
  }

  const values: Record<string, string> = {};
  for (const condition of conditions) {
    const verdict = evaluateCondition(condition, series, last);
    Object.assign(values, verdict.values);

    if (verdict.satisfied === null) {
      // Not a non-match: an unanswerable question. Reported rather than
      // dropped, so "nothing matched" stays distinguishable from "no data".
      return {
        match: null,
        skip: {
          symbol,
          reason: verdict.unknownReason ?? 'the condition could not be judged',
          missingField: verdict.missingField,
        },
      };
    }
    if (!verdict.satisfied) return { match: null, skip: null };
  }

  return {
    match: { symbol, asOf: series.openTime[last] ?? new Date(0), values },
    skip: null,
  };
}

/** Runs a filter across several symbols' series. */
export function runScan(
  entries: { symbol: string; series: IndicatorSeries }[],
  conditions: ScanCondition[],
): ScanOutcome {
  const matches: ScanMatch[] = [];
  const notEvaluable: ScanSkip[] = [];
  let evaluated = 0;

  for (const entry of entries) {
    const { match, skip } = evaluateSymbol(entry.symbol, entry.series, conditions);
    if (skip) {
      notEvaluable.push(skip);
      continue;
    }
    evaluated += 1;
    if (match) matches.push(match);
  }

  matches.sort((a, b) => a.symbol.localeCompare(b.symbol));
  return { matches, notEvaluable, evaluated };
}

/** Re-exported for callers that only need the rendering. */
export const describeFilter = (conditions: ScanCondition[]): string[] =>
  conditions.map(describeCondition);
