import { dec } from '@zusu/shared';
import { describe, expect, it } from 'vitest';
import { IndicatorService } from '../market-data/indicator.service.js';
import type { ProviderCandle } from '../market-data/types.js';
import type { RuleNode } from '../strategies/rule-tree.js';
import type { RiskSettings, StrategyDefinition } from '../strategies/strategy.service.js';
import { DEFAULT_COSTS, runBacktest, type BacktestCosts, type SymbolSeries } from './engine.js';
import { computeMetrics } from './metrics.js';

/**
 * The backtest engine.
 *
 * The tests that matter most here are the ones that would pass if the engine
 * cheated: a fill at the signal bar's close, a stop that holds through a gap,
 * an ambiguous bar resolved in the strategy's favour. Each is asserted
 * against, with the arithmetic written out, because "it looks about right" is
 * exactly how a backtest that cannot be trusted gets shipped.
 */

const indicators = new IndicatorService({} as never);

const BAR_MS = 300_000;
const START = Date.UTC(2026, 5, 1, 14, 0);

/** Costs switched off, so a test can check the engine's arithmetic alone. */
const NO_COSTS: BacktestCosts = {
  commissionPerTrade: dec(0),
  commissionPerShare: dec(0),
  spreadFraction: dec(0),
  slippageFraction: dec(0),
};

interface BarSpec {
  open: number;
  high?: number;
  low?: number;
  close: number;
}

function bars(symbol: string, specs: BarSpec[]): ProviderCandle[] {
  return specs.map((spec, i) => ({
    symbol,
    timeframe: '5m' as const,
    openTime: new Date(START + i * BAR_MS),
    closeTime: new Date(START + (i + 1) * BAR_MS),
    open: dec(spec.open),
    high: dec(spec.high ?? Math.max(spec.open, spec.close)),
    low: dec(spec.low ?? Math.min(spec.open, spec.close)),
    close: dec(spec.close),
    volume: dec(1_000),
    vwap: null,
    tradeCount: 10,
    isAdjusted: true,
  }));
}

function seriesOf(symbol: string, specs: BarSpec[]): SymbolSeries {
  const candles = bars(symbol, specs);
  return { symbol, candles, series: indicators.seriesFrom(candles) };
}

/** A rule that fires exactly when close is above the given level. */
const closeAbove = (level: number): RuleNode => ({
  type: 'condition',
  field: 'close',
  operator: 'gt',
  operand: { constant: String(level) },
});

const closeBelow = (level: number): RuleNode => ({
  type: 'condition',
  field: 'close',
  operator: 'lt',
  operand: { constant: String(level) },
});

function definition(overrides: Partial<StrategyDefinition> = {}): StrategyDefinition {
  return {
    timeframe: '5m',
    watchlistId: null,
    entry: { direction: 'LONG', when: closeAbove(100) },
    exit: null,
    stop: { kind: 'PERCENT', value: '2' },
    target: { kind: 'RISK_MULTIPLE', value: '2' },
    ...overrides,
  };
}

const risk: RiskSettings = {
  maxConcurrentPositions: 3,
  maxNotionalPerTrade: '10000',
  // Two bars: these fixtures are hand-written, and a 60-bar warm-up would mean
  // no test could reach an entry at all.
  minBars: 2,
};

function run(
  symbols: SymbolSeries[],
  options: {
    definition?: StrategyDefinition;
    risk?: Partial<RiskSettings>;
    costs?: BacktestCosts;
    capital?: string;
  } = {},
) {
  return runBacktest({
    definition: options.definition ?? definition(),
    riskSettings: { ...risk, ...options.risk },
    initialCapital: dec(options.capital ?? '10000'),
    costs: options.costs ?? NO_COSTS,
    symbols,
  });
}

describe('look-ahead bias', () => {
  it('fills an entry at the next bar’s open, never at the signal bar’s close', () => {
    // Bar 1 closes at 101 — the rule fires. Bar 2 opens at 110, far away.
    // A cheating engine buys at 101; an honest one pays 110.
    const result = run([
      seriesOf('AAPL', [
        { open: 99, close: 99 },
        { open: 99, close: 101 },
        { open: 110, close: 111 },
        { open: 111, close: 112 },
      ]),
    ]);

    expect(result.trades).toHaveLength(1);
    expect(result.trades[0]?.entryPrice.toString()).toBe('110');
    expect(result.trades[0]?.entryTime.toISOString()).toBe(
      new Date(START + 2 * BAR_MS).toISOString(),
    );
  });

  it('never opens a position on the last bar, because there is no next open', () => {
    const result = run([
      seriesOf('AAPL', [
        { open: 99, close: 99 },
        { open: 99, close: 99 },
        { open: 99, close: 101 },
      ]),
    ]);

    // The rule fired on the final bar. There is no bar to fill at, so nothing
    // was bought — rather than a fill at a price that was never quoted.
    expect(result.counters.entrySignals).toBe(1);
    expect(result.trades).toHaveLength(0);
  });

  it('a rule-driven exit also waits for the next open', () => {
    const result = run(
      [
        seriesOf('AAPL', [
          { open: 99, close: 99 },
          { open: 99, close: 101 },
          { open: 100, close: 101 },
          { open: 100, close: 90 },
          { open: 80, close: 80 },
          { open: 80, close: 80 },
        ]),
      ],
      {
        definition: definition({
          entry: { direction: 'LONG', when: closeAbove(100) },
          exit: { when: closeBelow(95) },
          stop: null,
          target: null,
        }),
      },
    );

    // Entry at bar 2's open (100). Bar 3 closes at 90, so the exit rule fires
    // there — and fills at bar 4's open of 80, not at the 90 that triggered it.
    expect(result.trades).toHaveLength(1);
    expect(result.trades[0]?.entryPrice.toString()).toBe('100');
    expect(result.trades[0]?.exitPrice.toString()).toBe('80');
    expect(result.trades[0]?.exitReason).toBe('RULE');
  });

  it('computing over a prefix gives the same trades as the full series', () => {
    // Prefix invariance: whatever the engine decides in the first N bars must
    // not change when later bars are appended. A look-ahead anywhere in the
    // pipeline breaks this.
    const specs: BarSpec[] = Array.from({ length: 40 }, (_, i) => ({
      open: 100 + i * 0.5,
      close: 100 + i * 0.5 + 0.2,
    }));

    const full = run([seriesOf('AAPL', specs)]);
    const prefix = run([seriesOf('AAPL', specs.slice(0, 20))]);

    const comparable = full.trades.filter(
      (trade) => trade.entryTime.getTime() < START + 19 * BAR_MS,
    );
    for (const [index, trade] of prefix.trades.entries()) {
      // The final trade of the prefix may be cut short by its shorter window,
      // so only the entries are compared.
      expect(trade.entryPrice.toString()).toBe(comparable[index]?.entryPrice.toString());
      expect(trade.entryTime.toISOString()).toBe(comparable[index]?.entryTime.toISOString());
    }
  });
});

describe('stops and targets', () => {
  it('fills a stop at the stop price when the bar trades through it', () => {
    const result = run([
      seriesOf('AAPL', [
        { open: 99, close: 99 },
        { open: 99, close: 101 },
        { open: 100, close: 100 },
        { open: 100, high: 100, low: 97, close: 99 },
      ]),
    ]);

    // Entry 100, stop 2% below = 98. Bar 3 has a low of 97, so 98 traded.
    expect(result.trades[0]?.exitReason).toBe('STOP');
    expect(result.trades[0]?.exitPrice.toString()).toBe('98');
  });

  it('fills at the open, not the stop, when a bar gaps through it', () => {
    const result = run([
      seriesOf('AAPL', [
        { open: 99, close: 99 },
        { open: 99, close: 101 },
        { open: 100, close: 100 },
        { open: 90, high: 91, low: 89, close: 90 },
      ]),
    ]);

    // The stop was 98 and the bar opened at 90. Claiming 98 would be inventing
    // a fill nobody could have had.
    expect(result.trades[0]?.exitPrice.toString()).toBe('90');
    expect(result.counters.gapThroughStop).toBe(1);
  });

  it('resolves a bar containing both stop and target against the position', () => {
    const result = run([
      seriesOf('AAPL', [
        { open: 99, close: 99 },
        { open: 99, close: 101 },
        { open: 100, close: 100 },
        // Stop 98, target 104 (2× the 2 of risk). This bar reaches both.
        { open: 100, high: 105, low: 97, close: 104 },
      ]),
    ]);

    expect(result.trades[0]?.exitReason).toBe('STOP');
    expect(result.trades[0]?.exitWasAmbiguous).toBe(true);
    expect(result.counters.ambiguousExitBars).toBe(1);
  });

  it('measures the target from the fill, not from the signal bar’s close', () => {
    const result = run([
      seriesOf('AAPL', [
        { open: 99, close: 99 },
        { open: 99, close: 101 },
        { open: 200, close: 200 },
        { open: 200, high: 209, low: 199, close: 208 },
      ]),
    ]);

    // Fill 200, stop 196, so risk is 4 and the target is 208 — measured from
    // the 200 actually paid, not from the 101 that triggered the signal.
    expect(result.trades[0]?.exitReason).toBe('TARGET');
    expect(result.trades[0]?.exitPrice.toString()).toBe('208');
  });

  it('holds a position with no stop and no target until the rule or the data ends', () => {
    const result = run(
      [
        seriesOf('AAPL', [
          { open: 99, close: 99 },
          { open: 99, close: 101 },
          { open: 100, close: 100 },
          { open: 50, low: 40, close: 45 },
        ]),
      ],
      { definition: definition({ stop: null, target: null }) },
    );

    expect(result.trades[0]?.exitReason).toBe('END_OF_DATA');
    expect(result.trades[0]?.rMultiple).toBeNull();
  });
});

describe('costs', () => {
  it('moves every fill against the position and charges both sides', () => {
    const result = run(
      [
        seriesOf('AAPL', [
          { open: 99, close: 99 },
          { open: 99, close: 101 },
          { open: 100, close: 100 },
          { open: 100, close: 100 },
        ]),
      ],
      {
        costs: {
          commissionPerTrade: dec('1'),
          commissionPerShare: dec('0'),
          spreadFraction: dec('0.001'),
          slippageFraction: dec('0.001'),
        },
      },
    );

    const trade = result.trades[0];
    // Buy at 100 × 1.002 = 100.2; the exit at the last close of 100 is sold at
    // 100 × 0.998 = 99.8.
    expect(trade?.entryPrice.toString()).toBe('100.2');
    expect(trade?.exitPrice.toString()).toBe('99.8');
    expect(trade?.fees.toString()).toBe('2');
    // Gross is negative here purely because of the spread, and net is worse.
    expect(trade?.netPnl.lessThan(trade?.grossPnl ?? dec(0))).toBe(true);
  });

  it('reports gross and net separately so the cost of trading is visible', () => {
    const result = run(
      [
        seriesOf('AAPL', [
          { open: 99, close: 99 },
          { open: 99, close: 101 },
          { open: 100, close: 100 },
          { open: 100, high: 110, low: 100, close: 110 },
        ]),
      ],
      { costs: DEFAULT_COSTS },
    );

    const metrics = computeMetrics(result, {
      initialCapital: dec('10000'),
      timeframe: '5m',
    });

    expect(dec(metrics.grossProfit).greaterThan(dec(metrics.netProfit))).toBe(true);
    expect(dec(metrics.feesPaid).greaterThan(0)).toBe(true);
    expect(dec(metrics.slippagePaid).greaterThan(0)).toBe(true);
  });
});

describe('position sizing and limits', () => {
  it('caps a position at the configured notional', () => {
    const result = run([
      seriesOf('AAPL', [
        { open: 99, close: 99 },
        { open: 99, close: 101 },
        { open: 100, close: 100 },
        { open: 100, close: 100 },
      ]),
    ]);

    // 10,000 of capital and a 10,000 cap, at 100 a share.
    expect(result.trades[0]?.quantity.toString()).toBe('100');
  });

  it('refuses a trade it cannot afford, and says so', () => {
    const result = run(
      [
        seriesOf('AAPL', [
          { open: 99, close: 99 },
          { open: 99, close: 101 },
          { open: 5_000, close: 5_000 },
          { open: 5_000, close: 5_000 },
        ]),
      ],
      { capital: '100' },
    );

    expect(result.trades).toHaveLength(0);
    expect(result.skips[0]?.reason).toContain('more than the');
  });

  it('respects the concurrent-position limit and records what it skipped', () => {
    const symbols = ['AAPL', 'MSFT', 'NVDA'].map((symbol) =>
      seriesOf(symbol, [
        { open: 99, close: 101 },
        { open: 100, close: 101 },
        { open: 100, close: 101 },
        { open: 100, close: 101 },
      ]),
    );

    const result = run(symbols, { risk: { maxConcurrentPositions: 2 }, capital: '100000' });

    expect(result.skips.some((skip) => skip.reason.includes('the configured maximum'))).toBe(true);
    // Never more than two at once, whatever the signals said.
    expect(Math.max(...result.equityCurve.map((point) => point.openPositions))).toBe(2);
  });

  it('will not ask a rule before the version’s declared warm-up', () => {
    const result = run(
      [
        seriesOf('AAPL', [
          { open: 99, close: 101 },
          { open: 100, close: 101 },
          { open: 100, close: 101 },
        ]),
      ],
      { risk: { minBars: 3 } },
    );

    // Three bars, a three-bar warm-up: only the last bar may be judged, and
    // its fill would need a fourth bar.
    expect(result.counters.barsEvaluated).toBe(1);
    expect(result.trades).toHaveLength(0);
  });

  it('counts a bar it could not judge instead of treating it as a no', () => {
    const result = run(
      [
        seriesOf('AAPL', [
          { open: 100, close: 100 },
          { open: 100, close: 100 },
          { open: 100, close: 100 },
        ]),
      ],
      {
        definition: definition({
          // sma50 needs fifty bars; three will never produce a value.
          entry: {
            direction: 'LONG',
            when: { type: 'condition', field: 'sma50', operator: 'gt', operand: { constant: '0' } },
          },
        }),
      },
    );

    expect(result.counters.unknownVerdicts).toBeGreaterThan(0);
    expect(result.counters.entrySignals).toBe(0);
  });
});

describe('shorts', () => {
  it('profits when price falls, and stops out when it rises', () => {
    const result = run(
      [
        seriesOf('AAPL', [
          { open: 101, close: 101 },
          { open: 101, close: 99 },
          { open: 100, close: 100 },
          { open: 100, high: 103, low: 100, close: 102 },
        ]),
      ],
      {
        definition: definition({
          entry: { direction: 'SHORT', when: closeBelow(100) },
          stop: { kind: 'PERCENT', value: '2' },
          target: null,
        }),
      },
    );

    // Short at 100 with a stop 2% above at 102; the bar reached 103.
    expect(result.trades[0]?.direction).toBe('SHORT');
    expect(result.trades[0]?.exitReason).toBe('STOP');
    expect(result.trades[0]?.exitPrice.toString()).toBe('102');
    expect(result.trades[0]?.netPnl.lessThan(0)).toBe(true);
  });
});

describe('determinism', () => {
  it('produces identical results from identical inputs', () => {
    const specs: BarSpec[] = Array.from({ length: 60 }, (_, i) => ({
      open: 100 + Math.sin(i / 3) * 5,
      close: 100 + Math.sin((i + 1) / 3) * 5,
    }));

    const first = run([seriesOf('AAPL', specs)]);
    const second = run([seriesOf('AAPL', specs)]);

    expect(JSON.stringify(first.trades)).toBe(JSON.stringify(second.trades));
    expect(JSON.stringify(first.counters)).toBe(JSON.stringify(second.counters));
  });
});
