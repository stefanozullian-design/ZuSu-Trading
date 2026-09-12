import { dec, type Decimal } from '@zusu/shared';
import { describe, expect, it } from 'vitest';
import type { IndicatorSeries } from './indicator.service.js';
import { describeCondition, evaluateSymbol, runScan, type ScanCondition } from './scanner.js';

/** A series with only the fields a test needs; the rest are all-null. */
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

const constant = (value: number | string) => ({ constant: String(value) });

describe('evaluateSymbol — constant comparisons', () => {
  const s = series({ length: 3, rsi14: d([50, 40, 28]), close: d([100, 99, 98]) });

  it('matches when the latest bar satisfies the condition', () => {
    const { match, skip } = evaluateSymbol('AAPL', s, [
      { field: 'rsi14', operator: 'lt', operand: constant(30) },
    ]);
    expect(skip).toBeNull();
    expect(match?.symbol).toBe('AAPL');
    // Evaluated at the last bar, not the first.
    expect(match?.values.rsi14).toBe('28');
  });

  it('does not match when it does not, and is not a skip', () => {
    const { match, skip } = evaluateSymbol('AAPL', s, [
      { field: 'rsi14', operator: 'gt', operand: constant(70) },
    ]);
    expect(match).toBeNull();
    expect(skip).toBeNull();
  });

  it('records the matching bar time', () => {
    const { match } = evaluateSymbol('AAPL', s, [
      { field: 'rsi14', operator: 'lt', operand: constant(30) },
    ]);
    expect(match?.asOf.toISOString()).toBe('2026-07-15T14:32:00.000Z');
  });

  it('handles each inequality at its boundary', () => {
    const flat = series({ length: 1, rsi14: d([30]) });
    const check = (operator: ScanCondition['operator']) =>
      evaluateSymbol('X', flat, [{ field: 'rsi14', operator, operand: constant(30) }]).match !==
      null;

    expect(check('gt')).toBe(false);
    expect(check('gte')).toBe(true);
    expect(check('lt')).toBe(false);
    expect(check('lte')).toBe(true);
  });
});

describe('evaluateSymbol — field comparisons', () => {
  it('compares one field to another', () => {
    const s = series({ length: 1, close: d([105]), sma20: d([100]) });
    const { match } = evaluateSymbol('AAPL', s, [
      { field: 'close', operator: 'gt', operand: { field: 'sma20' } },
    ]);
    expect(match).not.toBeNull();
    // Both sides are recorded, so the match can be checked by hand.
    expect(match?.values).toEqual({ close: '105', sma20: '100' });
  });

  it('does not match when the comparison fails', () => {
    const s = series({ length: 1, close: d([95]), sma20: d([100]) });
    const { match } = evaluateSymbol('AAPL', s, [
      { field: 'close', operator: 'gt', operand: { field: 'sma20' } },
    ]);
    expect(match).toBeNull();
  });
});

describe('evaluateSymbol — between', () => {
  it('is inclusive at both bounds', () => {
    for (const value of [30, 50, 70]) {
      const s = series({ length: 1, rsi14: d([value]) });
      const { match } = evaluateSymbol('X', s, [
        {
          field: 'rsi14',
          operator: 'between',
          operand: constant(30),
          operandUpper: constant(70),
        },
      ]);
      expect(match, `rsi ${String(value)}`).not.toBeNull();
    }
  });

  it('excludes values outside the range', () => {
    const s = series({ length: 1, rsi14: d([71]) });
    const { match } = evaluateSymbol('X', s, [
      { field: 'rsi14', operator: 'between', operand: constant(30), operandUpper: constant(70) },
    ]);
    expect(match).toBeNull();
  });

  it('skips when no upper bound was given', () => {
    const s = series({ length: 1, rsi14: d([50]) });
    const { skip } = evaluateSymbol('X', s, [
      { field: 'rsi14', operator: 'between', operand: constant(30) },
    ]);
    expect(skip?.reason).toContain('upper bound');
  });
});

describe('evaluateSymbol — crossings', () => {
  it('matches a genuine cross above', () => {
    // 99 -> 101 across a line at 100.
    const s = series({ length: 2, close: d([99, 101]), sma20: d([100, 100]) });
    const { match } = evaluateSymbol('AAPL', s, [
      { field: 'close', operator: 'crosses_above', operand: { field: 'sma20' } },
    ]);
    expect(match).not.toBeNull();
  });

  it('does not match merely being above on both bars', () => {
    // The distinction the whole operator exists for.
    const s = series({ length: 2, close: d([101, 102]), sma20: d([100, 100]) });
    const { match } = evaluateSymbol('AAPL', s, [
      { field: 'close', operator: 'crosses_above', operand: { field: 'sma20' } },
    ]);
    expect(match).toBeNull();
  });

  it('matches a cross below', () => {
    const s = series({ length: 2, close: d([101, 99]), sma20: d([100, 100]) });
    const { match } = evaluateSymbol('AAPL', s, [
      { field: 'close', operator: 'crosses_below', operand: { field: 'sma20' } },
    ]);
    expect(match).not.toBeNull();
  });

  it('treats touching then rising as a cross above', () => {
    // Previous bar exactly on the line counts as "not yet above".
    const s = series({ length: 2, close: d([100, 101]), sma20: d([100, 100]) });
    const { match } = evaluateSymbol('AAPL', s, [
      { field: 'close', operator: 'crosses_above', operand: { field: 'sma20' } },
    ]);
    expect(match).not.toBeNull();
  });

  it('skips when only one bar is stored', () => {
    const s = series({ length: 1, close: d([101]), sma20: d([100]) });
    const { skip } = evaluateSymbol('AAPL', s, [
      { field: 'close', operator: 'crosses_above', operand: { field: 'sma20' } },
    ]);
    // The reason comes from the per-condition evaluator, which knows precisely
    // which bar it was missing.
    expect(skip?.reason).toContain('needs a previous bar');
  });

  it('skips when the previous bar has no value for the field', () => {
    const s = series({ length: 2, close: d([99, 101]), sma20: d([null, 100]) });
    const { skip } = evaluateSymbol('AAPL', s, [
      { field: 'close', operator: 'crosses_above', operand: { field: 'sma20' } },
    ]);
    expect(skip).not.toBeNull();
  });
});

describe('evaluateSymbol — nulls are never matches', () => {
  it('skips rather than matching when the field is in warm-up', () => {
    const s = series({ length: 3, rsi14: d([null, null, null]) });
    const { match, skip } = evaluateSymbol('AAPL', s, [
      { field: 'rsi14', operator: 'lt', operand: constant(30) },
    ]);

    // A null is not "less than 30"; it is an unanswerable question.
    expect(match).toBeNull();
    expect(skip?.missingField).toBe('rsi14');
    expect(skip?.reason).toContain('warm-up');
  });

  it('skips when the compared field is in warm-up', () => {
    const s = series({ length: 1, close: d([105]), sma50: d([null]) });
    const { skip } = evaluateSymbol('AAPL', s, [
      { field: 'close', operator: 'gt', operand: { field: 'sma50' } },
    ]);
    expect(skip?.missingField).toBe('sma50');
  });

  it('skips a symbol with no bars at all', () => {
    const { skip } = evaluateSymbol('AAPL', series({ length: 0 }), [
      { field: 'close', operator: 'gt', operand: constant(1) },
    ]);
    expect(skip?.reason).toContain('no stored bars');
    expect(skip?.missingField).toBeNull();
  });

  it('skips on a non-numeric constant rather than matching', () => {
    const s = series({ length: 1, rsi14: d([50]) });
    const { match, skip } = evaluateSymbol('X', s, [
      { field: 'rsi14', operator: 'lt', operand: constant('not-a-number') },
    ]);
    expect(match).toBeNull();
    expect(skip).not.toBeNull();
  });
});

describe('evaluateSymbol — multiple conditions', () => {
  const s = series({
    length: 2,
    close: d([100, 105]),
    sma20: d([99, 100]),
    rsi14: d([50, 45]),
    volume: d([1_000, 5_000]),
  });

  it('requires every condition to hold', () => {
    const { match } = evaluateSymbol('AAPL', s, [
      { field: 'close', operator: 'gt', operand: { field: 'sma20' } },
      { field: 'rsi14', operator: 'lt', operand: constant(50) },
      { field: 'volume', operator: 'gt', operand: constant(2_000) },
    ]);
    expect(match).not.toBeNull();
    expect(Object.keys(match?.values ?? {}).sort()).toEqual(['close', 'rsi14', 'sma20', 'volume']);
  });

  it('fails the whole scan when one condition fails', () => {
    const { match, skip } = evaluateSymbol('AAPL', s, [
      { field: 'close', operator: 'gt', operand: { field: 'sma20' } },
      { field: 'rsi14', operator: 'gt', operand: constant(60) },
    ]);
    expect(match).toBeNull();
    expect(skip).toBeNull();
  });

  it('matches everything when there are no conditions', () => {
    const { match } = evaluateSymbol('AAPL', s, []);
    // An empty filter is "every symbol with data", which is a useful listing
    // rather than an error.
    expect(match).not.toBeNull();
    expect(match?.values).toEqual({});
  });
});

describe('runScan', () => {
  const matching = series({ length: 1, rsi14: d([25]) });
  const notMatching = series({ length: 1, rsi14: d([60]) });
  const warmingUp = series({ length: 1, rsi14: d([null]) });

  it('separates matches, non-matches and unevaluable symbols', () => {
    const outcome = runScan(
      [
        { symbol: 'AAPL', series: matching },
        { symbol: 'MSFT', series: notMatching },
        { symbol: 'NVDA', series: warmingUp },
      ],
      [{ field: 'rsi14', operator: 'lt', operand: constant(30) }],
    );

    expect(outcome.matches.map((m) => m.symbol)).toEqual(['AAPL']);
    expect(outcome.notEvaluable.map((s) => s.symbol)).toEqual(['NVDA']);
    // Two symbols got a real verdict; the third could not be judged.
    expect(outcome.evaluated).toBe(2);
  });

  it('sorts matches by symbol so results are stable', () => {
    const outcome = runScan(
      [
        { symbol: 'TSLA', series: matching },
        { symbol: 'AAPL', series: matching },
        { symbol: 'MSFT', series: matching },
      ],
      [{ field: 'rsi14', operator: 'lt', operand: constant(30) }],
    );
    expect(outcome.matches.map((m) => m.symbol)).toEqual(['AAPL', 'MSFT', 'TSLA']);
  });

  it('reports an empty universe without inventing results', () => {
    const outcome = runScan([], [{ field: 'rsi14', operator: 'lt', operand: constant(30) }]);
    expect(outcome).toEqual({ matches: [], notEvaluable: [], evaluated: 0 });
  });
});

describe('describeCondition', () => {
  it('renders each operator in words', () => {
    expect(describeCondition({ field: 'rsi14', operator: 'lt', operand: constant(30) })).toBe(
      'rsi14 below 30',
    );
    expect(
      describeCondition({ field: 'close', operator: 'crosses_above', operand: { field: 'sma20' } }),
    ).toBe('close crosses above sma20');
    expect(
      describeCondition({
        field: 'rsi14',
        operator: 'between',
        operand: constant(30),
        operandUpper: constant(70),
      }),
    ).toBe('rsi14 between 30 and 70');
  });
});
