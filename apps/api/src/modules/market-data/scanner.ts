import { Decimal, dec } from '@zusu/shared';
import type { IndicatorSeries } from './indicator.service.js';

/**
 * The scanner's filter evaluator (§9).
 *
 * A scan is a flat list of conditions, all of which must hold. Deliberately
 * flat rather than a nested boolean tree: a rule tree with AND/OR/NOT is the
 * strategy engine's job in Phase 3, and building a second, subtly different
 * expression language here would guarantee the two disagree.
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
 *      the series and never looks past it, which is the same causality rule the
 *      indicator engine holds to.
 */

export const SCAN_FIELDS = [
  'close',
  'volume',
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
] as const;
export type ScanField = (typeof SCAN_FIELDS)[number];

export const SCAN_OPERATORS = [
  'gt',
  'gte',
  'lt',
  'lte',
  'between',
  'crosses_above',
  'crosses_below',
] as const;
export type ScanOperator = (typeof SCAN_OPERATORS)[number];

/**
 * The right-hand side of a condition: a constant, or another field.
 *
 * Field-to-field comparison is what makes the scanner worth having —
 * "close above its 20-period average" is a far more useful question than
 * "close above 184".
 */
export type ScanOperand = { constant: string } | { field: ScanField };

export interface ScanCondition {
  field: ScanField;
  operator: ScanOperator;
  /** Right-hand side. `between` uses this as the lower bound. */
  operand: ScanOperand;
  /** Upper bound, `between` only. */
  operandUpper?: ScanOperand;
}

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
 * Returns a match, or a skip explaining why no verdict was possible, or null
 * for a clean non-match.
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

  const needsPrevious = conditions.some(
    (c) => c.operator === 'crosses_above' || c.operator === 'crosses_below',
  );
  if (needsPrevious && last < 1) {
    return {
      match: null,
      skip: {
        symbol,
        reason: 'a crossing needs two bars, and only one is stored',
        missingField: null,
      },
    };
  }

  const values: Record<string, string> = {};
  const read = (field: ScanField, index: number): Decimal | null => {
    const value = series[field][index] ?? null;
    return value;
  };

  for (const condition of conditions) {
    const current = read(condition.field, last);
    if (current === null) {
      // Warm-up, or a gap. Not a non-match: an unanswerable question.
      return {
        match: null,
        skip: {
          symbol,
          reason: `${condition.field} has no value at the latest bar (warm-up or missing data)`,
          missingField: condition.field,
        },
      };
    }
    values[condition.field] = current.toString();

    const bound = resolveOperand(condition.operand, series, last);
    if (bound === null) {
      return {
        match: null,
        skip: {
          symbol,
          reason: `${describeOperand(condition.operand)} has no value at the latest bar`,
          missingField: 'field' in condition.operand ? condition.operand.field : null,
        },
      };
    }
    if ('field' in condition.operand) values[condition.operand.field] = bound.toString();

    if (condition.operator === 'between') {
      if (!condition.operandUpper) {
        return {
          match: null,
          skip: { symbol, reason: 'between requires an upper bound', missingField: null },
        };
      }
      const upper = resolveOperand(condition.operandUpper, series, last);
      if (upper === null) {
        return {
          match: null,
          skip: {
            symbol,
            reason: `${describeOperand(condition.operandUpper)} has no value at the latest bar`,
            missingField: 'field' in condition.operandUpper ? condition.operandUpper.field : null,
          },
        };
      }
      if ('field' in condition.operandUpper) {
        values[condition.operandUpper.field] = upper.toString();
      }
      if (current.lt(bound) || current.gt(upper)) return { match: null, skip: null };
      continue;
    }

    if (condition.operator === 'crosses_above' || condition.operator === 'crosses_below') {
      const previous = read(condition.field, last - 1);
      const previousBound = resolveOperand(condition.operand, series, last - 1);
      if (previous === null || previousBound === null) {
        return {
          match: null,
          skip: {
            symbol,
            reason: `a crossing needs the previous bar, and ${condition.field} has no value there`,
            missingField: condition.field,
          },
        };
      }
      // A crossing is a change of side between two adjacent bars, not merely
      // being on one side of the line now.
      const crossed =
        condition.operator === 'crosses_above'
          ? previous.lte(previousBound) && current.gt(bound)
          : previous.gte(previousBound) && current.lt(bound);
      if (!crossed) return { match: null, skip: null };
      continue;
    }

    const satisfied =
      condition.operator === 'gt'
        ? current.gt(bound)
        : condition.operator === 'gte'
          ? current.gte(bound)
          : condition.operator === 'lt'
            ? current.lt(bound)
            : current.lte(bound);
    if (!satisfied) return { match: null, skip: null };
  }

  const asOf = series.openTime[last];
  return {
    match: {
      symbol,
      asOf: asOf ?? new Date(0),
      values,
    },
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

function resolveOperand(
  operand: ScanOperand,
  series: IndicatorSeries,
  index: number,
): Decimal | null {
  if ('constant' in operand) {
    try {
      const value = dec(operand.constant);
      return value.isFinite() ? value : null;
    } catch {
      return null;
    }
  }
  return series[operand.field][index] ?? null;
}

function describeOperand(operand: ScanOperand): string {
  return 'constant' in operand ? operand.constant : operand.field;
}

/** A short human-readable rendering of a condition, for the UI and audit. */
export function describeCondition(condition: ScanCondition): string {
  const operators: Record<ScanOperator, string> = {
    gt: 'above',
    gte: 'at or above',
    lt: 'below',
    lte: 'at or below',
    between: 'between',
    crosses_above: 'crosses above',
    crosses_below: 'crosses below',
  };
  const right = describeOperand(condition.operand);
  if (condition.operator === 'between' && condition.operandUpper) {
    return `${condition.field} between ${right} and ${describeOperand(condition.operandUpper)}`;
  }
  return `${condition.field} ${operators[condition.operator]} ${right}`;
}
