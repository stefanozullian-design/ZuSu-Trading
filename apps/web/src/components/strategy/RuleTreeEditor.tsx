import { Plus } from 'lucide-react';
import { ConditionRow, selectClass } from '@/components/market/ConditionRow';
import type { RuleNode } from '@/lib/types';

/**
 * Edits a nested AND / OR / NOT rule.
 *
 * Two limits are deliberate and mirror the API: depth stops at six and a group
 * holds at most ten children. A rule nobody can read is a rule nobody can
 * check, and this is the editor where that gets decided rather than the
 * request handler.
 *
 * There is no "empty group" state that silently means true: a group with no
 * children renders a prompt, and the API answers `unknown` rather than
 * guessing — unknown is never permission to trade.
 */

const MAX_DEPTH = 6;
const MAX_CHILDREN = 10;

const newCondition = (): RuleNode => ({
  type: 'condition',
  field: 'rsi14',
  operator: 'lt',
  operand: { constant: '30' },
});

interface Props {
  node: RuleNode;
  onChange: (next: RuleNode) => void;
  /** Removes this node from its parent. Absent at the root, which must exist. */
  onRemove?: () => void;
  depth?: number;
  /** Distinguishes the entry rule's controls from the exit rule's. */
  labelPrefix: string;
  path?: string;
}

export function RuleTreeEditor({
  node,
  onChange,
  onRemove,
  depth = 0,
  labelPrefix,
  path = '1',
}: Props) {
  const name = `${labelPrefix} rule ${path}`;

  if (node.type === 'condition') {
    const { type: _type, ...condition } = node;
    return (
      <ConditionRow
        condition={condition}
        removeLabel={`Remove ${name}`}
        onChange={(next) => onChange({ type: 'condition', ...next })}
        onRemove={() => onRemove?.()}
      />
    );
  }

  const children = node.type === 'not' ? [node.child] : node.children;
  const canNest = depth + 1 < MAX_DEPTH;
  // A NOT holds exactly one child, so only a group can grow.
  const group = node.type === 'not' ? null : node;
  const canAdd = group !== null && children.length < MAX_CHILDREN;

  const replaceChild = (index: number, next: RuleNode) => {
    if (node.type === 'not') return onChange({ type: 'not', child: next });
    onChange({ ...node, children: children.map((c, i) => (i === index ? next : c)) });
  };

  const removeChild = (index: number) => {
    if (node.type === 'not') {
      // Removing the only child of a NOT removes the NOT: a negation of
      // nothing has no meaning worth keeping.
      return onRemove ? onRemove() : onChange(newCondition());
    }
    onChange({ ...node, children: children.filter((_, i) => i !== index) });
  };

  return (
    <div className="space-y-2 rounded-md border border-border bg-muted/20 p-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <select
          className={selectClass}
          value={node.type}
          aria-label={`${name} group type`}
          onChange={(e) => {
            const type = e.target.value as RuleNode['type'];
            if (type === 'not')
              return onChange({ type: 'not', child: children[0] ?? newCondition() });
            if (type === 'condition') return onChange(newCondition());
            onChange({ type, children });
          }}
        >
          <option value="all">all of</option>
          <option value="any">any of</option>
          <option value="not">not</option>
          <option value="condition">a single condition</option>
        </select>

        <span className="text-[11px] text-muted-foreground">
          {node.type === 'all' && 'every condition below must hold'}
          {node.type === 'any' && 'at least one condition below must hold'}
          {node.type === 'not' && 'the condition below must not hold'}
        </span>

        {onRemove && (
          <button
            type="button"
            className="ml-auto rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label={`Remove ${name}`}
            onClick={onRemove}
          >
            remove group
          </button>
        )}
      </div>

      {children.length === 0 && (
        <p className="text-[11px] text-amber-400">
          An empty group cannot be judged, so the strategy will report{' '}
          <span className="font-medium">unknown</span> rather than fire. Add a condition.
        </p>
      )}

      <div className="space-y-2 border-l border-border pl-2">
        {children.map((child, index) => (
          <RuleTreeEditor
            key={index}
            node={child}
            depth={depth + 1}
            labelPrefix={labelPrefix}
            path={`${path}.${String(index + 1)}`}
            onChange={(next) => replaceChild(index, next)}
            onRemove={() => removeChild(index)}
          />
        ))}
      </div>

      {canAdd && group && (
        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            className={selectClass}
            onClick={() => onChange({ ...group, children: [...children, newCondition()] })}
          >
            <Plus className="mr-1 inline h-3 w-3" aria-hidden />
            {`Add condition to ${name}`}
          </button>
          {canNest && (
            <button
              type="button"
              className={selectClass}
              onClick={() =>
                onChange({
                  ...group,
                  children: [...children, { type: 'any', children: [newCondition()] }],
                })
              }
            >
              <Plus className="mr-1 inline h-3 w-3" aria-hidden />
              {`Add group to ${name}`}
            </button>
          )}
        </div>
      )}

      {!canNest && (
        <p className="text-[11px] text-muted-foreground">
          Six levels is the limit. A rule deeper than this is one nobody reviews honestly.
        </p>
      )}
    </div>
  );
}
