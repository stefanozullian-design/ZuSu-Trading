import { dec } from '@zusu/shared';
import { describe, expect, it } from 'vitest';
import { IndicatorService } from '../market-data/indicator.service.js';
import type { ProviderCandle } from '../market-data/types.js';
import type { RuleNode } from '../strategies/rule-tree.js';
import type { RiskSettings, StrategyDefinition } from '../strategies/strategy.service.js';
import { monteCarlo, optimiseParameters, seededRandom, walkForward } from './analysis.js';
import type { AnalysisInput, ParameterCandidate } from './analysis.js';
import type { BacktestCosts, BacktestTrade, SymbolSeries } from './engine.js';

/**
 * Walk-forward, Monte Carlo and parameter search.
 *
 * These tests are mostly about the warnings. A parameter search that returns a
 * winner and nothing else is a machine for producing overfitted strategies, so
 * the cases below check that the reasons to doubt a result are actually
 * produced — including in the cases where the result looks best.
 */

const indicators = new IndicatorService({} as never);
const BAR_MS = 300_000;
const START = Date.UTC(2026, 5, 1, 14, 0);

const NO_COSTS: BacktestCosts = {
  commissionPerTrade: dec(0),
  commissionPerShare: dec(0),
  spreadFraction: dec(0),
  slippageFraction: dec(0),
};

const risk: RiskSettings = {
  maxConcurrentPositions: 1,
  maxNotionalPerTrade: '10000',
  minBars: 2,
};

/** A sawtooth: price rises for five bars, falls for five, forever. */
function sawtooth(symbol: string, length: number): ProviderCandle[] {
  return Array.from({ length }, (_, i) => {
    const phase = i % 10;
    const level = 100 + (phase < 5 ? phase : 10 - phase) * 2;
    const next = 100 + (phase + 1 < 5 ? phase + 1 : 10 - (phase + 1)) * 2;
    return {
      symbol,
      timeframe: '5m' as const,
      openTime: new Date(START + i * BAR_MS),
      closeTime: new Date(START + (i + 1) * BAR_MS),
      open: dec(level),
      high: dec(Math.max(level, next) + 0.5),
      low: dec(Math.min(level, next) - 0.5),
      close: dec(next),
      volume: dec(1_000),
      vwap: null,
      tradeCount: 10,
      isAdjusted: true,
    };
  });
}

function seriesOf(symbol: string, candles: ProviderCandle[]): SymbolSeries {
  return { symbol, candles, series: indicators.seriesFrom(candles) };
}

const closeAbove = (level: number): RuleNode => ({
  type: 'condition',
  field: 'close',
  operator: 'gt',
  operand: { constant: String(level) },
});

function definition(level = 102): StrategyDefinition {
  return {
    timeframe: '5m',
    watchlistId: null,
    entry: { direction: 'LONG', when: closeAbove(level) },
    exit: null,
    stop: { kind: 'PERCENT', value: '2' },
    target: { kind: 'PERCENT', value: '3' },
  };
}

function input(length = 200, overrides: Partial<AnalysisInput> = {}): AnalysisInput {
  const candles = sawtooth('AAPL', length);
  return {
    definition: definition(),
    riskSettings: risk,
    initialCapital: dec('10000'),
    costs: NO_COSTS,
    symbols: [seriesOf('AAPL', candles)],
    timeframe: '5m',
    seriesFrom: (slice) => indicators.seriesFrom(slice),
    ...overrides,
  };
}

function trade(netPnl: number): BacktestTrade {
  return {
    symbol: 'AAPL',
    direction: 'LONG',
    quantity: dec(100),
    entryTime: new Date(START),
    entryPrice: dec(100),
    exitTime: new Date(START + BAR_MS),
    exitPrice: dec(101),
    grossPnl: dec(netPnl),
    fees: dec(0),
    slippage: dec(0),
    netPnl: dec(netPnl),
    rMultiple: null,
    maeAmount: dec(0),
    mfeAmount: dec(0),
    exitReason: 'TARGET',
    barsHeld: 2,
    exitWasAmbiguous: false,
  };
}

describe('walk-forward', () => {
  it('refuses to split a window too short to split', () => {
    const result = walkForward(input(20), { folds: 4 });

    expect(result.folds).toHaveLength(0);
    expect(result.verdict).toContain('too few to split');
  });

  it('splits the window into consecutive, non-overlapping folds', () => {
    const result = walkForward(input(400), { folds: 4 });

    expect(result.folds.length).toBeGreaterThan(1);
    for (const fold of result.folds) {
      // In-sample always precedes out-of-sample; an overlap would be the
      // whole point of walk-forward, defeated.
      expect(fold.inSampleTo.getTime()).toBeLessThan(fold.outOfSampleFrom.getTime());
    }
    for (let i = 1; i < result.folds.length; i += 1) {
      const previous = result.folds[i - 1]!;
      const current = result.folds[i]!;
      expect(current.inSampleFrom.getTime()).toBeGreaterThan(previous.inSampleFrom.getTime());
    }
  });

  it('recomputes indicators per fold rather than borrowing the full series', () => {
    // A fold that reused a series computed over all 400 bars would see a
    // 50-period average inside its first ten bars. Asking for sma50 on short
    // folds must therefore produce no trades at all.
    const result = walkForward(
      input(400, {
        definition: {
          ...definition(),
          entry: {
            direction: 'LONG',
            when: { type: 'condition', field: 'sma50', operator: 'gt', operand: { constant: '0' } },
          },
        },
        riskSettings: { ...risk, minBars: 2 },
      }),
      { folds: 8 },
    );

    // Each fold is 50 bars, 35 of them in sample — never 50 closes of history
    // plus one, so sma50 is null throughout and nothing trades.
    const inSampleTrades = result.folds.reduce((total, fold) => total + fold.inSampleTrades, 0);
    expect(inSampleTrades).toBe(0);
  });

  it('says a fold is not comparable rather than reporting a degradation from two trades', () => {
    const result = walkForward(input(400), { folds: 8, outOfSampleFraction: 0.1 });

    const thin = result.folds.filter((fold) => fold.outOfSampleTrades < 5);
    for (const fold of thin) expect(fold.degradationPct).toBeNull();
  });

  it('names the number of profitable folds rather than only the average', () => {
    const result = walkForward(input(400), { folds: 4 });

    expect(result.verdict).toMatch(/folds|measures stability|summarised/);
    expect(result.profitableFolds).toBeLessThanOrEqual(result.folds.length);
  });
});

describe('monte carlo', () => {
  it('is deterministic for a given seed', () => {
    const trades = [trade(100), trade(-50), trade(200), trade(-150)];
    const first = monteCarlo(trades, { initialCapital: dec('10000'), seed: 7, iterations: 200 });
    const second = monteCarlo(trades, { initialCapital: dec('10000'), seed: 7, iterations: 200 });

    expect(first.equityPercentiles).toEqual(second.equityPercentiles);
    expect(first.worstDrawdownPct).toBe(second.worstDrawdownPct);
  });

  it('gives a different answer for a different seed, so the seed is real', () => {
    // Enough distinct outcomes that two seeds cannot coincide by accident: a
    // four-value trade list produces so few possible sums that identical
    // percentiles would prove nothing either way.
    const trades = Array.from({ length: 12 }, (_, i) =>
      trade((i % 2 === 0 ? 1 : -1) * (i + 3) * 7),
    );
    const a = monteCarlo(trades, { initialCapital: dec('10000'), seed: 1, iterations: 200 });
    const b = monteCarlo(trades, { initialCapital: dec('10000'), seed: 2, iterations: 200 });

    expect(a.equityPercentiles).not.toEqual(b.equityPercentiles);
  });

  it('finds a deeper drawdown than the realised ordering', () => {
    // Alternating wins and losses never draws down much; a resampled run that
    // happens to put the losses together does.
    const trades = [trade(100), trade(-90), trade(100), trade(-90), trade(100), trade(-90)];
    const result = monteCarlo(trades, {
      initialCapital: dec('1000'),
      seed: 42,
      iterations: 500,
    });

    expect(Number(result.worstDrawdownPct)).toBeGreaterThan(9);
    expect(result.verdict).toContain('Size the position for that number');
  });

  it('reports an absent result as absent, not as a favourable one', () => {
    const result = monteCarlo([trade(500)], { initialCapital: dec('10000') });

    expect(result.iterations).toBe(0);
    expect(result.verdict).toContain('it is an absent one');
    expect(result.probabilityOfLossPct).toBe('0');
  });

  it('reports the probability of ending below the starting capital', () => {
    // Every trade loses, so every ordering ends lower.
    const trades = [trade(-10), trade(-20), trade(-30)];
    const result = monteCarlo(trades, {
      initialCapital: dec('1000'),
      seed: 3,
      iterations: 100,
    });

    expect(result.probabilityOfLossPct).toBe('100');
  });
});

describe('the seeded generator', () => {
  it('produces the same sequence for the same seed, and covers [0, 1)', () => {
    const a = seededRandom(99);
    const b = seededRandom(99);
    const values = Array.from({ length: 500 }, () => a());

    expect(values.slice(0, 5)).toEqual(Array.from({ length: 5 }, () => b()));
    expect(Math.min(...values)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...values)).toBeLessThan(1);
  });
});

describe('parameter search', () => {
  const candidates: ParameterCandidate[] = [100, 101, 102, 103, 104].map((level) => ({
    label: `close above ${String(level)}`,
    definition: definition(level),
  }));

  it('ranks candidates and names a best', () => {
    const result = optimiseParameters(input(400), candidates);

    expect(result.candidates).toHaveLength(5);
    expect(result.best).not.toBeNull();
    // Ranked, so each score is at least the next.
    for (let i = 1; i < result.candidates.length; i += 1) {
      expect(
        dec(result.candidates[i - 1]!.score).greaterThanOrEqualTo(dec(result.candidates[i]!.score)),
      ).toBe(true);
    }
  });

  it('always warns that the best of many is partly a count of the many', () => {
    const result = optimiseParameters(input(400), candidates);

    expect(result.warnings.join(' ')).toContain('parameter sets were tried');
  });

  it('warns when the winner rests on too few trades', () => {
    const result = optimiseParameters(input(60), candidates);

    expect(result.warnings.join(' ')).toMatch(/trades\. Below/);
  });

  it('warns when most of the family loses money', () => {
    const losers: ParameterCandidate[] = [200, 201, 202].map((level) => ({
      label: `close above ${String(level)}`,
      // Nothing reaches 200, so these never trade — and a candidate that never
      // trades has a zero return, which counts as not profitable.
      definition: definition(level),
    }));

    const result = optimiseParameters(input(400), [...losers, ...candidates.slice(0, 1)]);
    expect(result.warnings.join(' ')).toContain('lost money');
  });

  it('changes nothing on its own — the result is a ranking, not a decision', () => {
    const original = input(400);
    const before = JSON.stringify(original.definition);
    optimiseParameters(original, candidates);

    // The definition handed in is untouched: optimisation proposes, a person
    // promotes. Nothing here writes a version or changes a live strategy.
    expect(JSON.stringify(original.definition)).toBe(before);
  });
});
