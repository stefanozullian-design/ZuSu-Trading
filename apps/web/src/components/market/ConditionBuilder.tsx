import { Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { ScanCondition } from '@/lib/types';

const FIELDS = [
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

const OPERATORS: { value: string; label: string }[] = [
  { value: 'gt', label: 'above' },
  { value: 'gte', label: 'at or above' },
  { value: 'lt', label: 'below' },
  { value: 'lte', label: 'at or below' },
  { value: 'between', label: 'between' },
  { value: 'crosses_above', label: 'crosses above' },
  { value: 'crosses_below', label: 'crosses below' },
];

interface Props {
  conditions: ScanCondition[];
  onChange: (conditions: ScanCondition[]) => void;
}

const selectClass =
  'rounded-md border border-input bg-background px-2 py-1 text-xs text-foreground ' +
  'focus:outline-none focus:ring-1 focus:ring-ring';

/**
 * Builds a flat list of ANDed conditions.
 *
 * Flat on purpose: a nested AND/OR/NOT tree is the strategy builder's job in
 * Phase 3, and a second, subtly different expression editor here would be a
 * guarantee that the two disagree.
 *
 * The right-hand side can be a number or another field — "close above sma20"
 * is the question worth asking, not "close above 184".
 */
export function ConditionBuilder({ conditions, onChange }: Props) {
  const update = (index: number, next: ScanCondition) => {
    onChange(conditions.map((c, i) => (i === index ? next : c)));
  };

  const add = () => {
    onChange([...conditions, { field: 'rsi14', operator: 'lt', operand: { constant: '30' } }]);
  };

  return (
    <div className="space-y-2">
      {conditions.length === 0 && (
        <p className="text-xs text-muted-foreground">
          No conditions. A scan with none matches every symbol that has enough data — a useful
          listing rather than an error.
        </p>
      )}

      {conditions.map((condition, index) => {
        const usesConstant = 'constant' in condition.operand;
        const needsUpper = condition.operator === 'between';

        return (
          <div
            key={index}
            className="flex flex-wrap items-center gap-1.5 rounded-md border border-border bg-muted/30 p-2"
          >
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
              {index === 0 ? 'where' : 'and'}
            </span>

            <select
              className={selectClass}
              value={condition.field}
              aria-label="Field"
              onChange={(e) => update(index, { ...condition, field: e.target.value })}
            >
              {FIELDS.map((field) => (
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
                update(index, {
                  ...condition,
                  operator,
                  // Leaving a stale upper bound on a non-range operator would
                  // be silently ignored by the API; drop it instead.
                  operandUpper:
                    operator === 'between'
                      ? (condition.operandUpper ?? { constant: '70' })
                      : undefined,
                });
              }}
            >
              {OPERATORS.map((operator) => (
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
                update(index, {
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
                onChange={(e) =>
                  update(index, { ...condition, operand: { constant: e.target.value } })
                }
              />
            ) : (
              <select
                className={selectClass}
                value={(condition.operand as { field: string }).field}
                aria-label="Compared field"
                onChange={(e) =>
                  update(index, { ...condition, operand: { field: e.target.value } })
                }
              >
                {FIELDS.map((field) => (
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
                  onChange={(e) =>
                    update(index, {
                      ...condition,
                      operandUpper: { constant: e.target.value },
                    })
                  }
                />
              </>
            )}

            <button
              type="button"
              className="ml-auto rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-label={`Remove condition ${String(index + 1)}`}
              onClick={() => onChange(conditions.filter((_, i) => i !== index))}
            >
              <X className="h-3.5 w-3.5" aria-hidden />
            </button>
          </div>
        );
      })}

      <Button variant="ghost" size="sm" onClick={add} className="text-xs">
        <Plus className="mr-1 h-3.5 w-3.5" aria-hidden />
        Add condition
      </Button>
    </div>
  );
}
