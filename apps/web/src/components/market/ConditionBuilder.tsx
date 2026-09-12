import { Plus } from 'lucide-react';
import { ConditionRow } from '@/components/market/ConditionRow';
import { Button } from '@/components/ui/button';
import type { ScanCondition } from '@/lib/types';

interface Props {
  conditions: ScanCondition[];
  onChange: (conditions: ScanCondition[]) => void;
}

/**
 * Builds a flat list of ANDed conditions.
 *
 * Flat on purpose: nesting belongs to the strategy builder, which uses the
 * same {@link ConditionRow} so a condition means one thing in both places.
 *
 * The right-hand side can be a number or another field — "close above sma20"
 * is the question worth asking, not "close above 184".
 */
export function ConditionBuilder({ conditions, onChange }: Props) {
  return (
    <div className="space-y-2">
      {conditions.length === 0 && (
        <p className="text-xs text-muted-foreground">
          No conditions. A scan with none matches every symbol that has enough data — a useful
          listing rather than an error.
        </p>
      )}

      {conditions.map((condition, index) => (
        <ConditionRow
          key={index}
          condition={condition}
          prefix={index === 0 ? 'where' : 'and'}
          removeLabel={`Remove condition ${String(index + 1)}`}
          onChange={(next) => onChange(conditions.map((c, i) => (i === index ? next : c)))}
          onRemove={() => onChange(conditions.filter((_, i) => i !== index))}
        />
      ))}

      <Button
        variant="ghost"
        size="sm"
        className="text-xs"
        onClick={() =>
          onChange([...conditions, { field: 'rsi14', operator: 'lt', operand: { constant: '30' } }])
        }
      >
        <Plus className="mr-1 h-3.5 w-3.5" aria-hidden />
        Add condition
      </Button>
    </div>
  );
}
