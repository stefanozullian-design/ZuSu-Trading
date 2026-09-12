import { z } from 'zod';
import {
  SCAN_FIELDS,
  SCAN_OPERATORS,
  describeCondition,
  evaluateCondition,
  type ScanCondition,
  type ScanField,
} from '../market-data/condition.js';
import type { IndicatorSeries } from '../market-data/indicator.service.js';

/**
 * The strategy rule tree (§10).
 *
 * A strategy is **data, never code**. This module can evaluate a tree and
 * explain what it decided; it cannot run anything a user supplied, because
 * there is nothing to run — a rule is a nested record of conditions, and the
 * only operations are `all`, `any` and `not` over leaves the scanner already
 * defines.
 *
 * Three properties the tests check rather than assume:
 *
 *   1. **Three-valued logic.** A verdict is true, false, or unknown, and
 *      unknown is *not* false. `all` over [true, unknown] is unknown, not
 *      false; `any` over [false, unknown] is unknown, not false. An indicator
 *      in warm-up has no value, and a strategy that treated that as "condition
 *      not met" would silently change meaning as history accumulated.
 *
 *   2. **Nothing fires on unknown.** `shouldFire` is true only for a decided
 *      `true`. This is the safety property: a rule the engine could not
 *      evaluate never produces a signal.
 *
 *   3. **Every verdict carries a trace.** The tree's decision is reconstructible
 *      from the result — which branch decided it and what the values were. A
 *      signal whose reasoning cannot be shown is a signal nobody can audit,
 *      and this platform's whole premise is that a person stays accountable.
 *
 * Depth and breadth are bounded. An unbounded tree from an HTTP body is a way
 * to spend the process's stack on a stranger's behalf.
 */

export const MAX_TREE_DEPTH = 6;
export const MAX_CHILDREN = 10;
export const MAX_TREE_NODES = 60;

export type RuleNode =
  | { type: 'all'; children: RuleNode[] }
  | { type: 'any'; children: RuleNode[] }
  | { type: 'not'; child: RuleNode }
  | ({ type: 'condition' } & ScanCondition);

const operandSchema = z.union([
  z.object({
    constant: z
      .string()
      .min(1)
      .max(32)
      .refine((value) => Number.isFinite(Number(value)), { message: 'must be a number' }),
  }),
  z.object({ field: z.enum(SCAN_FIELDS) }),
]);

const conditionLeafSchema = z.object({
  type: z.literal('condition'),
  field: z.enum(SCAN_FIELDS),
  operator: z.enum(SCAN_OPERATORS),
  operand: operandSchema,
  operandUpper: operandSchema.optional(),
});

/**
 * The tree schema, built recursively to a fixed depth.
 *
 * Written as an explicit ladder rather than with `z.lazy`: a lazy recursive
 * schema has no depth limit, and the limit is the point.
 */
function treeSchemaAtDepth(depth: number): z.ZodType<RuleNode> {
  if (depth <= 1) return conditionLeafSchema as unknown as z.ZodType<RuleNode>;
  const child = treeSchemaAtDepth(depth - 1);
  return z.union([
    conditionLeafSchema as unknown as z.ZodType<RuleNode>,
    z.object({ type: z.literal('all'), children: z.array(child).min(1).max(MAX_CHILDREN) }),
    z.object({ type: z.literal('any'), children: z.array(child).min(1).max(MAX_CHILDREN) }),
    z.object({ type: z.literal('not'), child }),
  ]) as unknown as z.ZodType<RuleNode>;
}

export const ruleNodeSchema: z.ZodType<RuleNode> = treeSchemaAtDepth(MAX_TREE_DEPTH).superRefine(
  (node, ctx) => {
    const total = countNodes(node);
    if (total > MAX_TREE_NODES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `a rule may contain at most ${String(MAX_TREE_NODES)} nodes, got ${String(total)}`,
      });
    }
  },
) as unknown as z.ZodType<RuleNode>;

export function countNodes(node: RuleNode): number {
  switch (node.type) {
    case 'all':
    case 'any':
      return 1 + node.children.reduce((sum, child) => sum + countNodes(child), 0);
    case 'not':
      return 1 + countNodes(node.child);
    default:
      return 1;
  }
}

export function treeDepth(node: RuleNode): number {
  switch (node.type) {
    case 'all':
    case 'any':
      return 1 + Math.max(...node.children.map(treeDepth));
    case 'not':
      return 1 + treeDepth(node.child);
    default:
      return 1;
  }
}

/** Every field a tree reads. Used to report what a strategy depends on. */
export function fieldsUsed(node: RuleNode): ScanField[] {
  const found = new Set<ScanField>();
  const walk = (current: RuleNode): void => {
    switch (current.type) {
      case 'all':
      case 'any':
        current.children.forEach(walk);
        return;
      case 'not':
        walk(current.child);
        return;
      default:
        found.add(current.field);
        if ('field' in current.operand) found.add(current.operand.field);
        if (current.operandUpper && 'field' in current.operandUpper) {
          found.add(current.operandUpper.field);
        }
    }
  };
  walk(node);
  return [...found].sort();
}

/** A node's contribution to the decision, for the audit trail. */
export interface RuleTrace {
  type: RuleNode['type'];
  /** True, false, or null for undecidable. */
  satisfied: boolean | null;
  /** A readable rendering of what this node asked. */
  description: string;
  /** Why it could not be decided. Null when it was. */
  unknownReason?: string;
  /** Values the leaf read. Only on condition nodes. */
  values?: Record<string, string>;
  children?: RuleTrace[];
}

export interface RuleEvaluation {
  satisfied: boolean | null;
  /** Only a decided `true` may act. Unknown never fires. */
  shouldFire: boolean;
  trace: RuleTrace;
  /** Every value read anywhere in the tree, flattened. */
  values: Record<string, string>;
  /** Fields that had no value, if any. */
  missingFields: ScanField[];
}

/**
 * Evaluates a tree at one bar.
 *
 * Short-circuiting is deliberately *not* done: `all` keeps evaluating after a
 * false child, and `any` after a true one. A trace that stops at the deciding
 * branch cannot answer "what else was true at the time", which is the first
 * question anyone asks of a signal after the fact.
 */
export function evaluateRule(
  node: RuleNode,
  series: IndicatorSeries,
  index: number,
): RuleEvaluation {
  const values: Record<string, string> = {};
  const missing = new Set<ScanField>();
  const trace = walk(node, series, index, values, missing);

  return {
    satisfied: trace.satisfied,
    // The safety property: unknown is not permission.
    shouldFire: trace.satisfied === true,
    trace,
    values,
    missingFields: [...missing].sort(),
  };
}

function walk(
  node: RuleNode,
  series: IndicatorSeries,
  index: number,
  values: Record<string, string>,
  missing: Set<ScanField>,
): RuleTrace {
  if (node.type === 'condition') {
    const verdict = evaluateCondition(node, series, index);
    Object.assign(values, verdict.values);
    if (verdict.missingField) missing.add(verdict.missingField);

    return {
      type: 'condition',
      satisfied: verdict.satisfied,
      description: describeCondition(node),
      ...(verdict.unknownReason ? { unknownReason: verdict.unknownReason } : {}),
      values: verdict.values,
    };
  }

  if (node.type === 'not') {
    const child = walk(node.child, series, index, values, missing);
    return {
      type: 'not',
      // Negating unknown leaves unknown: the absence of an answer is not an
      // answer in the other direction.
      satisfied: child.satisfied === null ? null : !child.satisfied,
      description: `not (${child.description})`,
      children: [child],
    };
  }

  const children = node.children.map((child) => walk(child, series, index, values, missing));
  const satisfied = node.type === 'all' ? kleeneAll(children) : kleeneAny(children);
  const joiner = node.type === 'all' ? ' and ' : ' or ';

  return {
    type: node.type,
    satisfied,
    description: `(${children.map((c) => c.description).join(joiner)})`,
    children,
  };
}

/** False if any child is false; otherwise unknown if any is unknown. */
function kleeneAll(children: RuleTrace[]): boolean | null {
  if (children.some((child) => child.satisfied === false)) return false;
  if (children.some((child) => child.satisfied === null)) return null;
  return true;
}

/** True if any child is true; otherwise unknown if any is unknown. */
function kleeneAny(children: RuleTrace[]): boolean | null {
  if (children.some((child) => child.satisfied === true)) return true;
  if (children.some((child) => child.satisfied === null)) return null;
  return false;
}

/** A one-line rendering of a tree, for a list or a log. */
export function describeRule(node: RuleNode): string {
  switch (node.type) {
    case 'all':
      return `(${node.children.map(describeRule).join(' and ')})`;
    case 'any':
      return `(${node.children.map(describeRule).join(' or ')})`;
    case 'not':
      return `not (${describeRule(node.child)})`;
    default:
      return describeCondition(node);
  }
}
