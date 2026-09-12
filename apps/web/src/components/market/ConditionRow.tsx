import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ScanCondition } from '@/lib/types';

/**
 * One condition, editable.
 *
 * Shared by the scanner's flat list and the strategy builder's nested tree so
 * the two cannot drift: a second, subtly different condition editor would be a
 * guarantee that a rule means one thing in a scan and another in a strategy.
 */

export const CONDITION_FIELDS = [
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

export const CONDITION_OPERATORS: { value: string; label: string }[] = [
  { value: 'gt', label: 'above' },
  { value: 'gte', label: 'at or above' },
  { value: 'lt', label: 'below' },
  { value: 'lte', label: 'at or below' },
  { value: 'between', label: 'between' },
  { value: 'crosses_above', label: 'crosses above' },
  { value: 'crosses_below', label: 'crosses below' },
];

export const selectClass =
  'rounded-md border border-input bg-background px-2 py-1 text-xs text-foreground ' +
  'focus:outline-none focus:ring-1 focus:ring-ring';

interface Props {
  condition: ScanCondition;
  onChange: (next: ScanCondition) => void;
  onRemove: () => void;
  /** Accessible name for the remove button, e.g. "Remove condition 2". */
  removeLabel: string;
  /** Leading word — "where", "and", or nothing inside a tree. */
  prefix?: string;
}

export function ConditionRow({ condition, onChange, onRemove, removeLabel, prefix }: Props) {
  const usesConstant = 'constant' in condition.operand;
  const needsUpper = condition.operator === 'between';

  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-border bg-muted/30 p-2">
      {prefix && (
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{prefix}</span>
      )}

      <select
        className={selectClass}
        value={condition.field}
        aria-label="Field"
        onChange={(e) => onChange({ ...condition, field: e.target.value })}
      >
        {CONDITION_FIELDS.map((field) => (
          <option key={field} value={field}>
            {field}
          </option>
        ))}
      </select>

      <select
        className={selectClass}
        value={condition.operator}
        aria-label="Operator"
        onChange={(e) => {
          const operator = e.target.value;
          onChange({
            ...condition,
            operator,
            // Leaving a stale upper bound on a non-range operator would be
            // silently ignored by the API; drop it instead.
            operandUpper:
              operator === 'between' ? (condition.operandUpper ?? { constant: '70' }) : undefined,
          });
        }}
      >
        {CONDITION_OPERATORS.map((operator) => (
          <option key={operator.value} value={operator.value}>
            {operator.label}
          </option>
        ))}
      </select>

      <select
        className={selectClass}
        value={usesConstant ? 'constant' : 'field'}
        aria-label="Compare to"
        onChange={(e) =>
          onChange({
            ...condition,
            operand: e.target.value === 'constant' ? { constant: '0' } : { field: 'sma20' },
          })
        }
      >
        <option value="constant">a number</option>
        <option value="field">another field</option>
      </select>

      {usesConstant ? (
        <input
          className={cn(selectClass, 'w-24 tabular-nums')}
          value={(condition.operand as { constant: string }).constant}
          aria-label="Value"
          inputMode="decimal"
          onChange={(e) => onChange({ ...condition, operand: { constant: e.target.value } })}
        />
      ) : (
        <select
          className={selectClass}
          value={(condition.operand as { field: string }).field}
          aria-label="Compared field"
          onChange={(e) => onChange({ ...condition, operand: { field: e.target.value } })}
        >
          {CONDITION_FIELDS.map((field) => (
            <option key={field} value={field}>
              {field}
            </option>
          ))}
        </select>
      )}

      {needsUpper && (
        <>
          <span className="text-xs text-muted-foreground">and</span>
          <input
            className={cn(selectClass, 'w-24 tabular-nums')}
            value={
              condition.operandUpper && 'constant' in condition.operandUpper
                ? condition.operandUpper.constant
                : ''
            }
            aria-label="Upper bound"
            inputMode="decimal"
            onChange={(e) => onChange({ ...condition, operandUpper: { constant: e.target.value } })}
          />
        </>
      )}

      <button
        type="button"
        className="ml-auto rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        aria-label={removeLabel}
        onClick={onRemove}
      >
        <X className="h-3.5 w-3.5" aria-hidden />
      </button>
    </div>
  );
}
