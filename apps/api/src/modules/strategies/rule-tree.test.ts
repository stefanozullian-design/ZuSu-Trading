import { dec, type Decimal } from '@zusu/shared';
import { describe, expect, it } from 'vitest';
import type { IndicatorSeries } from '../market-data/indicator.service.js';
import {
  MAX_TREE_DEPTH,
  MAX_TREE_NODES,
  countNodes,
  describeRule,
  evaluateRule,
  fieldsUsed,
  ruleNodeSchema,
  treeDepth,
  type RuleNode,
} from './rule-tree.js';

/** A series carrying only the fields a test needs; the rest are all-null. */
function series(overrides: Partial<Record<keyof IndicatorSeries, unknown>> & { length: number }) {
  const n = overrides.length;
  const nulls = () => new Array<Decimal | null>(n).fill(null);
  const base: IndicatorSeries = {
    length: n,
    openTime: Array.from({ length: n }, (_, i) => new Date(Date.UTC(2026, 6, 15, 14, 30 + i))),
    close: nulls(),
    volume: nulls(),
    sma20: nulls(),
    sma50: nulls(),
    ema12: nulls(),
    ema26: nulls(),
    rsi14: nulls(),
    macd: nulls(),
    macdSignal: nulls(),
    macdHistogram: nulls(),
    bollingerUpper: nulls(),
    bollingerMiddle: nulls(),
    bollingerLower: nulls(),
    atr14: nulls(),
    vwap: nulls(),
    stochasticK: nulls(),
    stochasticD: nulls(),
  };
  return { ...base, ...overrides } as IndicatorSeries;
}

const d = (values: (number | null)[]): (Decimal | null)[] =>
  values.map((v) => (v === null ? null : dec(v)));

const cond = (
  field: 'rsi14' | 'close' | 'sma20' | 'sma50' | 'volume',
  operator: 'gt' | 'lt' | 'gte' | 'lte',
  constant: number,
): RuleNode => ({ type: 'condition', field, operator, operand: { constant: String(constant) } });

/** rsi14 40, close 100, sma20 99 — enough for most of the logic tests. */
const basic = series({
  length: 2,
  rsi14: d([45, 40]),
  close: d([99, 100]),
  sma20: d([98, 99]),
  volume: d([500, 1_000]),
});

/** Same, but rsi14 has no value — the unknown case. */
const withUnknown = series({
  length: 2,
  rsi14: d([null, null]),
  close: d([99, 100]),
  sma20: d([98, 99]),
});

describe('evaluateRule — leaves', () => {
  it('decides a satisfied condition', () => {
    const result = evaluateRule(cond('rsi14', 'lt', 50), basic, 1);
    expect(result.satisfied).toBe(true);
    expect(result.shouldFire).toBe(true);
    expect(result.values.rsi14).toBe('40');
  });

  it('decides an unsatisfied condition', () => {
    const result = evaluateRule(cond('rsi14', 'gt', 50), basic, 1);
    expect(result.satisfied).toBe(false);
    expect(result.shouldFire).toBe(false);
  });

  it('reports an unknown condition as unknown, not false', () => {
    const result = evaluateRule(cond('rsi14', 'lt', 50), withUnknown, 1);
    expect(result.satisfied).toBeNull();
    expect(result.shouldFire).toBe(false);
    expect(result.missingFields).toEqual(['rsi14']);
    expect(result.trace.unknownReason).toMatch(/warm-up/);
  });

  it('evaluates at the requested bar, not the last one', () => {
    // rsi14 is 45 at bar 0 and 40 at bar 1.
    expect(evaluateRule(cond('rsi14', 'lt', 42), basic, 0).satisfied).toBe(false);
    expect(evaluateRule(cond('rsi14', 'lt', 42), basic, 1).satisfied).toBe(true);
  });
});

describe('evaluateRule — three-valued conjunction', () => {
  const table: [string, (boolean | null)[], boolean | null][] = [
    ['all true', [true, true], true],
    ['one false', [true, false], false],
    ['one unknown', [true, null], null],
    ['false beats unknown', [false, null], false],
    ['all unknown', [null, null], null],
  ];

  for (const [name, inputs, expected] of table) {
    it(`all: ${name}`, () => {
      const children = inputs.map(nodeFor);
      const result = evaluateRule({ type: 'all', children }, mixed, 1);
      expect(result.satisfied).toBe(expected);
    });
  }

  it('a false child makes the whole rule false even when another is unknown', () => {
    // This is the asymmetry that matters: false is decidable without the
    // missing value, so the answer exists.
    const result = evaluateRule(
      { type: 'all', children: [nodeFor(false), nodeFor(null)] },
      mixed,
      1,
    );
    expect(result.satisfied).toBe(false);
    expect(result.shouldFire).toBe(false);
  });
});

describe('evaluateRule — three-valued disjunction', () => {
  const table: [string, (boolean | null)[], boolean | null][] = [
    ['all false', [false, false], false],
    ['one true', [false, true], true],
    ['one unknown', [false, null], null],
    ['true beats unknown', [true, null], true],
    ['all unknown', [null, null], null],
  ];

  for (const [name, inputs, expected] of table) {
    it(`any: ${name}`, () => {
      const children = inputs.map(nodeFor);
      const result = evaluateRule({ type: 'any', children }, mixed, 1);
      expect(result.satisfied).toBe(expected);
    });
  }

  it('a true child decides the rule even when another is unknown', () => {
    const result = evaluateRule(
      { type: 'any', children: [nodeFor(true), nodeFor(null)] },
      mixed,
      1,
    );
    expect(result.satisfied).toBe(true);
    expect(result.shouldFire).toBe(true);
  });
});

describe('evaluateRule — negation', () => {
  it('negates a decided verdict', () => {
    expect(evaluateRule({ type: 'not', child: nodeFor(true) }, mixed, 1).satisfied).toBe(false);
    expect(evaluateRule({ type: 'not', child: nodeFor(false) }, mixed, 1).satisfied).toBe(true);
  });

  it('leaves unknown unknown', () => {
    // The absence of an answer is not an answer in the other direction.
    const result = evaluateRule({ type: 'not', child: nodeFor(null) }, mixed, 1);
    expect(result.satisfied).toBeNull();
    expect(result.shouldFire).toBe(false);
  });
});

describe('evaluateRule — nothing fires on unknown', () => {
  it('shouldFire is false for every undecided shape', () => {
    const shapes: RuleNode[] = [
      nodeFor(null),
      { type: 'all', children: [nodeFor(true), nodeFor(null)] },
      { type: 'any', children: [nodeFor(false), nodeFor(null)] },
      { type: 'not', child: nodeFor(null) },
      { type: 'all', children: [{ type: 'any', children: [nodeFor(null)] }] },
    ];

    for (const shape of shapes) {
      const result = evaluateRule(shape, mixed, 1);
      expect(result.satisfied, describeRule(shape)).toBeNull();
      // The safety property: an unevaluated rule is never permission.
      expect(result.shouldFire, describeRule(shape)).toBe(false);
    }
  });

  it('shouldFire is true only for a decided true', () => {
    expect(evaluateRule(nodeFor(true), mixed, 1).shouldFire).toBe(true);
    expect(evaluateRule(nodeFor(false), mixed, 1).shouldFire).toBe(false);
  });
});

describe('evaluateRule — the trace', () => {
  const rule: RuleNode = {
    type: 'all',
    children: [
      cond('rsi14', 'lt', 50),
      { type: 'any', children: [cond('close', 'gt', 200), cond('volume', 'gt', 500)] },
    ],
  };

  it('records every branch, not only the deciding one', () => {
    const result = evaluateRule(rule, basic, 1);

    expect(result.satisfied).toBe(true);
    expect(result.trace.children).toHaveLength(2);
    const any = result.trace.children?.[1];
    // `any` was decided by its second child, but the first is still recorded —
    // "what else was true at the time" is the first question asked of a signal.
    expect(any?.children).toHaveLength(2);
    expect(any?.children?.[0]?.satisfied).toBe(false);
    expect(any?.children?.[1]?.satisfied).toBe(true);
  });

  it('flattens every value it read', () => {
    const result = evaluateRule(rule, basic, 1);
    expect(result.values).toEqual({ rsi14: '40', close: '100', volume: '1000' });
  });

  it('renders each node in words', () => {
    const result = evaluateRule(rule, basic, 1);
    expect(result.trace.description).toBe(
      '(rsi14 below 50 and (close above 200 or volume above 500))',
    );
  });

  it('names the reason a branch could not be judged', () => {
    const result = evaluateRule(
      { type: 'all', children: [cond('rsi14', 'lt', 50)] },
      withUnknown,
      1,
    );
    expect(result.trace.children?.[0]?.unknownReason).toMatch(/no value/);
  });
});

describe('the schema', () => {
  it('accepts a well-formed tree', () => {
    const parsed = ruleNodeSchema.safeParse({
      type: 'all',
      children: [
        { type: 'condition', field: 'rsi14', operator: 'lt', operand: { constant: '30' } },
        {
          type: 'not',
          child: {
            type: 'condition',
            field: 'close',
            operator: 'gt',
            operand: { field: 'sma50' },
          },
        },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an unknown field', () => {
    const parsed = ruleNodeSchema.safeParse({
      type: 'condition',
      field: 'moon_phase',
      operator: 'lt',
      operand: { constant: '1' },
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a non-numeric constant', () => {
    const parsed = ruleNodeSchema.safeParse({
      type: 'condition',
      field: 'rsi14',
      operator: 'lt',
      operand: { constant: 'thirty' },
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects an empty group, which has no meaning', () => {
    expect(ruleNodeSchema.safeParse({ type: 'all', children: [] }).success).toBe(false);
  });

  it('rejects a tree deeper than the limit', () => {
    // An unbounded tree from an HTTP body spends the stack on a stranger's
    // behalf, so the depth cap is a real control rather than tidiness.
    let node: RuleNode = cond('rsi14', 'lt', 30);
    for (let i = 0; i < MAX_TREE_DEPTH + 2; i += 1) {
      node = { type: 'not', child: node };
    }
    expect(ruleNodeSchema.safeParse(node).success).toBe(false);
  });

  it('accepts a tree exactly at the depth limit', () => {
    let node: RuleNode = cond('rsi14', 'lt', 30);
    for (let i = 0; i < MAX_TREE_DEPTH - 1; i += 1) {
      node = { type: 'not', child: node };
    }
    expect(treeDepth(node)).toBe(MAX_TREE_DEPTH);
    expect(ruleNodeSchema.safeParse(node).success).toBe(true);
  });

  it('rejects a tree with too many nodes even when it is shallow', () => {
    const wide: RuleNode = {
      type: 'all',
      children: Array.from({ length: 10 }, () => ({
        type: 'any' as const,
        children: Array.from({ length: 10 }, () => cond('rsi14', 'lt', 30)),
      })),
    };
    expect(countNodes(wide)).toBeGreaterThan(MAX_TREE_NODES);
    expect(ruleNodeSchema.safeParse(wide).success).toBe(false);
  });

  it('rejects anything that is not a node at all', () => {
    for (const bad of [null, 'rsi14 < 30', 42, {}, { type: 'exec', code: 'rm -rf /' }]) {
      expect(ruleNodeSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('introspection', () => {
  const rule: RuleNode = {
    type: 'all',
    children: [
      cond('rsi14', 'lt', 30),
      {
        type: 'condition',
        field: 'close',
        operator: 'gt',
        operand: { field: 'sma50' },
      },
    ],
  };

  it('lists every field a rule reads, including compared ones', () => {
    // Used to tell a user which indicators a strategy depends on, and so how
    // much history it needs before it can say anything.
    expect(fieldsUsed(rule)).toEqual(['close', 'rsi14', 'sma50']);
  });

  it('counts nodes and measures depth', () => {
    expect(countNodes(rule)).toBe(3);
    expect(treeDepth(rule)).toBe(2);
  });

  it('renders a whole tree in one line', () => {
    expect(describeRule(rule)).toBe('(rsi14 below 30 and close above sma50)');
  });
});

// ---------------------------------------------------------------------------
// A series engineered so one field is true, one false and one unknown, which
// makes the truth tables above readable.
// ---------------------------------------------------------------------------

const mixed = series({
  length: 2,
  close: d([100, 100]), // close above 50 -> true
  volume: d([10, 10]), // volume above 50 -> false
  rsi14: d([null, null]), // unknown
});

function nodeFor(value: boolean | null): RuleNode {
  if (value === true) return cond('close', 'gt', 50);
  if (value === false) return cond('volume', 'gt', 50);
  return cond('rsi14', 'gt', 50);
}
