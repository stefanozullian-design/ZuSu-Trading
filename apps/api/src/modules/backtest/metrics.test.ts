import { dec } from '@zusu/shared';
import { describe, expect, it } from 'vitest';
import type { BacktestRun, BacktestTrade, EquityPoint } from './engine.js';
import { computeMetrics } from './metrics.js';

/**
 * Performance metrics.
 *
 * The interesting assertions are the refusals: a Sharpe ratio that is not
 * computed from nine observations, a CAGR that is not annualised from a week,
 * a profit factor that is null rather than infinite. A statistic printed to
 * two decimal places looks like a measurement whether or not it is one.
 */

const START = Date.UTC(2026, 0, 5, 14, 30);
const BAR_MS = 300_000;

function trade(overrides: Partial<BacktestTrade> = {}): BacktestTrade {
  return {
    symbol: 'AAPL',
    direction: 'LONG',
    quantity: dec(100),
    entryTime: new Date(START),
    entryPrice: dec(100),
    exitTime: new Date(START + BAR_MS),
    exitPrice: dec(101),
    grossPnl: dec(100),
    fees: dec(2),
    slippage: dec(1),
    netPnl: dec(97),
    rMultiple: dec('0.5'),
    maeAmount: dec(-20),
    mfeAmount: dec(120),
    exitReason: 'TARGET',
    barsHeld: 3,
    exitWasAmbiguous: false,
    ...overrides,
  };
}

/** An equity curve from a list of values, one bar apart. */
function curve(values: number[], options: { openFrom?: number } = {}): EquityPoint[] {
  return values.map((value, index) => ({
    at: new Date(START + index * BAR_MS),
    equity: dec(value),
    cash: dec(value),
    openPositions: options.openFrom !== undefined && index >= options.openFrom ? 1 : 0,
  }));
}

function run(overrides: Partial<BacktestRun> = {}): BacktestRun {
  return {
    trades: [],
    equityCurve: curve([10_000]),
    skips: [],
    counters: {
      barsEvaluated: 0,
      unknownVerdicts: 0,
      entrySignals: 0,
      ambiguousExitBars: 0,
      gapThroughStop: 0,
    },
    ...overrides,
  };
}

const options = { initialCapital: dec(10_000), timeframe: '5m' as const };

describe('profit and cost', () => {
  it('reports net, gross and the difference between them', () => {
    const metrics = computeMetrics(
      run({ trades: [trade(), trade()], equityCurve: curve([10_000, 10_194]) }),
      options,
    );

    expect(metrics.netProfit).toBe('194');
    expect(metrics.grossProfit).toBe('200');
    expect(metrics.feesPaid).toBe('4');
    expect(metrics.slippagePaid).toBe('2');
  });

  it('computes the total return from equity, not from the trade list', () => {
    // Equity includes an open position's mark-to-market; closed trades do not.
    const metrics = computeMetrics(
      run({ trades: [trade()], equityCurve: curve([10_000, 12_000]) }),
      options,
    );

    expect(metrics.totalReturnPct).toBe('20');
  });
});

describe('drawdown', () => {
  it('measures the deepest peak-to-trough fall', () => {
    const metrics = computeMetrics(
      run({ equityCurve: curve([10_000, 12_000, 9_000, 11_000]) }),
      options,
    );

    // 12,000 down to 9,000 is 25%.
    expect(metrics.maxDrawdownPct).toBe('25');
    expect(metrics.maxDrawdownAmount).toBe('3000');
  });

  it('reports the recovery as null when equity never regained its peak', () => {
    const metrics = computeMetrics(run({ equityCurve: curve([10_000, 12_000, 9_000]) }), options);

    expect(metrics.maxDrawdownPct).toBe('25');
    expect(metrics.maxDrawdownRecoveryBars).toBeNull();
  });

  it('counts recovery from the peak that was lost', () => {
    const metrics = computeMetrics(
      run({ equityCurve: curve([10_000, 12_000, 9_000, 10_000, 12_000]) }),
      options,
    );

    // The peak was at index 1 and was regained at index 4.
    expect(metrics.maxDrawdownRecoveryBars).toBe(3);
  });
});

describe('trade statistics', () => {
  it('separates wins, losses and scratches', () => {
    const metrics = computeMetrics(
      run({
        trades: [
          trade({ netPnl: dec(100) }),
          trade({ netPnl: dec(-50) }),
          trade({ netPnl: dec(0) }),
        ],
      }),
      options,
    );

    expect(metrics.winCount).toBe(1);
    expect(metrics.lossCount).toBe(1);
    // A trade that made exactly nothing is neither, and saying so keeps the
    // win rate from being quietly flattered.
    expect(metrics.scratchCount).toBe(1);
    expect(dec(metrics.winRatePct).toFixed(2)).toBe('33.33');
  });

  it('returns a null profit factor rather than infinity when nothing lost', () => {
    const metrics = computeMetrics(
      run({ trades: [trade({ netPnl: dec(100) }), trade({ netPnl: dec(50) })] }),
      options,
    );

    expect(metrics.profitFactor).toBeNull();
  });

  it('computes the profit factor and payoff ratio from net figures', () => {
    const metrics = computeMetrics(
      run({
        trades: [
          trade({ netPnl: dec(300) }),
          trade({ netPnl: dec(100) }),
          trade({ netPnl: dec(-200) }),
        ],
      }),
      options,
    );

    expect(metrics.profitFactor).toBe('2');
    // Average win 200 against an average loss of 200.
    expect(metrics.payoffRatio).toBe('1');
    expect(dec(metrics.expectancy).toFixed(2)).toBe('66.67');
  });

  it('tracks the longest winning and losing streaks', () => {
    const results = [1, 1, -1, -1, -1, 1];
    const metrics = computeMetrics(
      run({ trades: results.map((r) => trade({ netPnl: dec(r * 100) })) }),
      options,
    );

    expect(metrics.longestWinStreak).toBe(2);
    expect(metrics.longestLossStreak).toBe(3);
  });
});

describe('ratios it refuses to compute', () => {
  it('suppresses Sharpe and Sortino below thirty observations', () => {
    const metrics = computeMetrics(run({ equityCurve: curve([10_000, 10_100, 10_050]) }), options);

    expect(metrics.sharpe).toBeNull();
    expect(metrics.sortino).toBeNull();
    // And says it suppressed them, rather than leaving a blank to interpret.
    expect(metrics.caveats.ratiosSuppressed).toBe(true);
  });

  it('computes them once there are enough, annualised for the timeframe', () => {
    // Forty bars of alternating small moves: enough observations, and a
    // known-positive drift.
    const values = Array.from({ length: 41 }, (_, i) => 10_000 * 1.001 ** i);
    const metrics = computeMetrics(run({ equityCurve: curve(values) }), options);

    expect(metrics.caveats.ratiosSuppressed).toBe(false);
    // A perfectly steady rise has the same return every bar. Its dispersion
    // is nothing but arithmetic residue, and dividing by residue would give a
    // Sharpe ratio in the quadrillions — so it is withheld.
    expect(metrics.sharpe).toBeNull();

    const noisy = Array.from({ length: 41 }, (_, i) =>
      i % 2 === 0 ? 10_000 + i * 10 : 10_000 + i * 10 - 30,
    );
    const noisyMetrics = computeMetrics(run({ equityCurve: curve(noisy) }), options);
    expect(noisyMetrics.sharpe).not.toBeNull();
  });

  it('refuses to annualise a window shorter than a month', () => {
    const metrics = computeMetrics(run({ equityCurve: curve([10_000, 11_000, 12_000]) }), options);

    // Three five-minute bars compounded to a year is not a growth rate.
    expect(metrics.cagrPct).toBeNull();
  });

  it('annualises a window long enough to mean something', () => {
    const daily: EquityPoint[] = Array.from({ length: 200 }, (_, i) => ({
      at: new Date(Date.UTC(2026, 0, 5) + i * 86_400_000),
      equity: dec(10_000 * 1.001 ** i),
      cash: dec(0),
      openPositions: 0,
    }));

    const metrics = computeMetrics(run({ equityCurve: daily }), {
      initialCapital: dec(10_000),
      timeframe: '1d',
    });

    expect(metrics.cagrPct).not.toBeNull();
    expect(Number(metrics.cagrPct)).toBeGreaterThan(0);
  });
});

describe('caveats', () => {
  it('carries the counts that qualify the result', () => {
    const metrics = computeMetrics(
      run({
        trades: [trade({ exitReason: 'END_OF_DATA' }), trade()],
        skips: [{ at: new Date(START), symbol: 'MSFT', reason: 'no capital' }],
        counters: {
          barsEvaluated: 500,
          unknownVerdicts: 40,
          entrySignals: 12,
          ambiguousExitBars: 3,
          gapThroughStop: 2,
        },
      }),
      options,
    );

    expect(metrics.caveats).toMatchObject({
      ambiguousExits: 3,
      gapThroughStop: 2,
      unknownVerdicts: 40,
      signalsNotTaken: 1,
      openAtEnd: 1,
    });
  });

  it('reports exposure as the fraction of bars with capital at risk', () => {
    const metrics = computeMetrics(
      run({ equityCurve: curve([1, 2, 3, 4], { openFrom: 2 }) }),
      options,
    );

    expect(metrics.exposurePct).toBe('50');
  });
});

describe('ratios that are defined but misleading', () => {
  it('flags an annualised ratio computed from mostly flat bars', () => {
    // Forty bars, capital at risk in four of them. The ratio is arithmetically
    // fine and practically nonsense: the flat bars shrink the variance.
    const values = Array.from({ length: 41 }, (_, i) => 10_000 + (i % 2 === 0 ? i : i - 3));
    const points = curve(values).map((point, index) => ({
      ...point,
      openPositions: index > 36 ? 1 : 0,
    }));

    const metrics = computeMetrics(run({ equityCurve: points }), options);

    expect(metrics.sharpe).not.toBeNull();
    expect(metrics.caveats.ratiosInflatedByLowExposure).toBe(true);
  });

  it('does not flag a strategy that was mostly in the market', () => {
    const values = Array.from({ length: 41 }, (_, i) => 10_000 + (i % 2 === 0 ? i : i - 3));
    const points = curve(values).map((point) => ({ ...point, openPositions: 1 }));

    const metrics = computeMetrics(run({ equityCurve: points }), options);

    expect(metrics.caveats.ratiosInflatedByLowExposure).toBe(false);
  });
});
