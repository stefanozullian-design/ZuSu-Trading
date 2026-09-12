import { Decimal, dec } from '@zusu/shared';
import type { IndicatorSeries } from './indicator.service.js';

/**
 * A single condition over an indicator series, and how to judge it.
 *
 * Extracted so the scanner and the strategy engine share one expression
 * language. The scanner is the flat special case — a list of conditions that
 * must all hold; a strategy rule tree is the general case over the same
 * leaves. Two languages would eventually disagree about what `crosses_above`
 * means, and a strategy that backtested against one and traded against the
 * other would be worse than useless.
 *
 * Verdicts are three-valued: true, false, or **unknown**. Unknown is not
 * false. An indicator still in warm-up has no value, so a condition over it
 * has no answer — and a strategy must never act on one.
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
 * The right-hand side: a constant, or another field.
 *
 * Field-to-field comparison is what makes either feature worth having —
 * "close above its 50-period average" is a real question, "close above 184"
 * is a coincidence.
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

export interface ConditionVerdict {
  /** True, false, or null for "no answer available". */
  satisfied: boolean | null;
  /** Why there is no answer. Null when there is one. */
  unknownReason: string | null;
  /** The field whose absence made it unknown, when that is the cause. */
  missingField: ScanField | null;
  /** Every value the condition read, for the audit trail. */
  values: Record<string, string>;
}

/**
 * Judges one condition at a bar index.
 *
 * `index` is the bar being decided, and nothing later than it is ever read —
 * the same causality rule the indicator engine holds to. A crossing reads
 * `index - 1` as well, which is why it is unknown at the first bar.
 */
export function evaluateCondition(
  condition: ScanCondition,
  series: IndicatorSeries,
  index: number,
): ConditionVerdict {
  const values: Record<string, string> = {};

  if (index < 0 || index >= series.length) {
    return unknown('the bar being judged is outside the stored series', null, values);
  }

  const current = series[condition.field][index] ?? null;
  if (current === null) {
    return unknown(
      `${condition.field} has no value at the latest bar (warm-up or missing data)`,
      condition.field,
      values,
    );
  }
  values[condition.field] = current.toString();

  const bound = resolveOperand(condition.operand, series, index);
  if (bound === null) {
    return unknown(
      `${describeOperand(condition.operand)} has no value at the latest bar`,
      'field' in condition.operand ? condition.operand.field : null,
      values,
    );
  }
  if ('field' in condition.operand) values[condition.operand.field] = bound.toString();

  if (condition.operator === 'between') {
    if (!condition.operandUpper) {
      return unknown('between requires an upper bound', null, values);
    }
    const upper = resolveOperand(condition.operandUpper, series, index);
    if (upper === null) {
      return unknown(
        `${describeOperand(condition.operandUpper)} has no value at the latest bar`,
        'field' in condition.operandUpper ? condition.operandUpper.field : null,
        values,
      );
    }
    if ('field' in condition.operandUpper) {
      values[condition.operandUpper.field] = upper.toString();
    }
    return decided(current.gte(bound) && current.lte(upper), values);
  }

  if (condition.operator === 'crosses_above' || condition.operator === 'crosses_below') {
    if (index < 1) {
      return unknown('a crossing needs a previous bar, and this is the first', null, values);
    }
    const previous = series[condition.field][index - 1] ?? null;
    const previousBound = resolveOperand(condition.operand, series, index - 1);
    if (previous === null || previousBound === null) {
      return unknown(
        `a crossing needs the previous bar, and ${condition.field} has no value there`,
        condition.field,
        values,
      );
    }
    // A crossing is a change of side between two adjacent bars, not merely
    // being on one side of the line now.
    const crossed =
      condition.operator === 'crosses_above'
        ? previous.lte(previousBound) && current.gt(bound)
        : previous.gte(previousBound) && current.lt(bound);
    return decided(crossed, values);
  }

  const satisfied =
    condition.operator === 'gt'
      ? current.gt(bound)
      : condition.operator === 'gte'
        ? current.gte(bound)
        : condition.operator === 'lt'
          ? current.lt(bound)
          : current.lte(bound);
  return decided(satisfied, values);
}

function decided(satisfied: boolean, values: Record<string, string>): ConditionVerdict {
  return { satisfied, unknownReason: null, missingField: null, values };
}

function unknown(
  reason: string,
  missingField: ScanField | null,
  values: Record<string, string>,
): ConditionVerdict {
  return { satisfied: null, unknownReason: reason, missingField, values };
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

export function describeOperand(operand: ScanOperand): string {
  return 'constant' in operand ? operand.constant : operand.field;
}

/** A short human-readable rendering, for the UI and the audit trail. */
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
