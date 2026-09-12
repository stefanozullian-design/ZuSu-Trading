import Decimal from 'decimal.js';
import { dec } from '@zusu/shared';
import { TIMEFRAME_MINUTES, type Timeframe } from '../market-data/types.js';
import type { BacktestRun, BacktestTrade, EquityPoint } from './engine.js';

/**
 * Performance metrics (§30).
 *
 * Every figure here is computed from net profit — after commission, spread and
 * slippage — because a gross return is not a return anybody could have earned.
 * `grossProfit` is reported alongside it so the cost of trading is visible as a
 * number rather than absorbed into a flattering total.
 *
 * Ratios that need a distribution (Sharpe, Sortino) are null below thirty
 * observations rather than computed from eight. A Sharpe ratio from a handful
 * of trades is noise wearing the costume of a statistic, and rendering it at
 * two decimal places would make it look like a measurement.
 */

const MIN_OBSERVATIONS_FOR_RATIOS = 30;
const TRADING_DAYS_PER_YEAR = 252;
/** 09:30–16:00 is six and a half hours of regular session. */
const REGULAR_SESSION_MINUTES = 390;

export interface BacktestMetrics {
  initialCapital: string;
  finalEquity: string;
  /** Net of every modelled cost. */
  netProfit: string;
  grossProfit: string;
  feesPaid: string;
  slippagePaid: string;
  totalReturnPct: string;
  /** Null when the window is shorter than a month: annualising eight days of
   * data produces a number with no meaning. */
  cagrPct: string | null;
  maxDrawdownPct: string;
  maxDrawdownAmount: string;
  /** How long the deepest drawdown took to recover, in bars. Null if it never did. */
  maxDrawdownRecoveryBars: number | null;
  tradeCount: number;
  winCount: number;
  lossCount: number;
  scratchCount: number;
  winRatePct: string;
  avgWin: string;
  avgLoss: string;
  /** Gross wins over gross losses. Null when there were no losses to divide by. */
  profitFactor: string | null;
  expectancy: string;
  avgRMultiple: string | null;
  payoffRatio: string | null;
  sharpe: string | null;
  sortino: string | null;
  /** Fraction of bars during which capital was at risk. */
  exposurePct: string;
  avgBarsHeld: string;
  longestWinStreak: number;
  longestLossStreak: number;
  /** Counts that qualify the result rather than decorate it. */
  caveats: {
    ambiguousExits: number;
    gapThroughStop: number;
    unknownVerdicts: number;
    signalsNotTaken: number;
    openAtEnd: number;
    ratiosSuppressed: boolean;
    /**
     * True when capital was at risk in under a quarter of the bars.
     *
     * Annualising bar-to-bar returns assumes the strategy was in the market;
     * when it mostly was not, the flat bars shrink the variance and the ratio
     * comes out far larger than anything a person would experience. The
     * figure is still reported, with this flag next to it.
     */
    ratiosInflatedByLowExposure: boolean;
  };
}

export function computeMetrics(
  run: BacktestRun,
  options: { initialCapital: Decimal; timeframe: Timeframe },
): BacktestMetrics {
  const { trades, equityCurve } = run;
  const initial = options.initialCapital;
  const finalEquity = equityCurve[equityCurve.length - 1]?.equity ?? initial;

  const netProfit = sum(trades.map((t) => t.netPnl));
  const grossProfit = sum(trades.map((t) => t.grossPnl));
  const feesPaid = sum(trades.map((t) => t.fees));
  const slippagePaid = sum(trades.map((t) => t.slippage));

  const wins = trades.filter((t) => t.netPnl.greaterThan(0));
  const losses = trades.filter((t) => t.netPnl.lessThan(0));
  const scratches = trades.length - wins.length - losses.length;

  const grossWins = sum(wins.map((t) => t.netPnl));
  const grossLosses = sum(losses.map((t) => t.netPnl)).abs();

  const drawdown = deepestDrawdown(equityCurve);
  const returns = periodReturns(equityCurve);
  const enoughObservations = returns.length >= MIN_OBSERVATIONS_FOR_RATIOS;
  const periodsPerYear = periodsPerYearFor(options.timeframe);

  const withR = trades.filter((t) => t.rMultiple !== null);
  const barsExposed = equityCurve.filter((point) => point.openPositions > 0).length;

  return {
    initialCapital: initial.toString(),
    finalEquity: finalEquity.toString(),
    netProfit: netProfit.toString(),
    grossProfit: grossProfit.toString(),
    feesPaid: feesPaid.toString(),
    slippagePaid: slippagePaid.toString(),
    totalReturnPct: initial.greaterThan(0)
      ? finalEquity.minus(initial).div(initial).times(100).toString()
      : '0',
    cagrPct: cagr(initial, finalEquity, equityCurve),
    maxDrawdownPct: drawdown.percent.toString(),
    maxDrawdownAmount: drawdown.amount.toString(),
    maxDrawdownRecoveryBars: drawdown.recoveryBars,
    tradeCount: trades.length,
    winCount: wins.length,
    lossCount: losses.length,
    scratchCount: scratches,
    winRatePct: trades.length > 0 ? dec(wins.length).div(trades.length).times(100).toString() : '0',
    avgWin: wins.length > 0 ? grossWins.div(wins.length).toString() : '0',
    avgLoss: losses.length > 0 ? grossLosses.div(losses.length).negated().toString() : '0',
    profitFactor: grossLosses.greaterThan(0) ? grossWins.div(grossLosses).toString() : null,
    expectancy: trades.length > 0 ? netProfit.div(trades.length).toString() : '0',
    avgRMultiple:
      withR.length > 0
        ? sum(withR.map((t) => t.rMultiple ?? dec(0)))
            .div(withR.length)
            .toString()
        : null,
    payoffRatio:
      wins.length > 0 && losses.length > 0
        ? grossWins.div(wins.length).div(grossLosses.div(losses.length)).toString()
        : null,
    sharpe: enoughObservations ? sharpeRatio(returns, periodsPerYear) : null,
    sortino: enoughObservations ? sortinoRatio(returns, periodsPerYear) : null,
    exposurePct:
      equityCurve.length > 0 ? dec(barsExposed).div(equityCurve.length).times(100).toString() : '0',
    avgBarsHeld:
      trades.length > 0
        ? dec(trades.reduce((total, t) => total + t.barsHeld, 0))
            .div(trades.length)
            .toString()
        : '0',
    longestWinStreak: longestStreak(trades, (t) => t.netPnl.greaterThan(0)),
    longestLossStreak: longestStreak(trades, (t) => t.netPnl.lessThan(0)),
    caveats: {
      ambiguousExits: run.counters.ambiguousExitBars,
      gapThroughStop: run.counters.gapThroughStop,
      unknownVerdicts: run.counters.unknownVerdicts,
      signalsNotTaken: run.skips.length,
      openAtEnd: trades.filter((t) => t.exitReason === 'END_OF_DATA').length,
      ratiosSuppressed: !enoughObservations,
      ratiosInflatedByLowExposure:
        enoughObservations &&
        equityCurve.length > 0 &&
        dec(barsExposed).div(equityCurve.length).lessThan(dec('0.25')),
    },
  };
}

function sum(values: Decimal[]): Decimal {
  return values.reduce((total, value) => total.plus(value), dec(0));
}

/**
 * The deepest peak-to-trough fall in equity, and how long it took to recover.
 *
 * Measured on the equity curve rather than on closed trades, because a
 * drawdown a person would have lived through includes the open position that
 * was down forty percent before it came back.
 */
function deepestDrawdown(curve: EquityPoint[]): {
  percent: Decimal;
  amount: Decimal;
  recoveryBars: number | null;
} {
  let peak = curve[0]?.equity ?? dec(0);
  let peakIndex = 0;
  let worst = { percent: dec(0), amount: dec(0), troughIndex: -1, peak: peak, peakIndex: 0 };

  curve.forEach((point, index) => {
    if (point.equity.greaterThan(peak)) {
      peak = point.equity;
      peakIndex = index;
    }
    if (peak.lessThanOrEqualTo(0)) return;

    const fall = peak.minus(point.equity);
    const percent = fall.div(peak).times(100);
    if (percent.greaterThan(worst.percent)) {
      // The peak this fall started from is kept with it, so recovery is
      // measured against the level that was actually lost.
      worst = { percent, amount: fall, troughIndex: index, peak, peakIndex };
    }
  });

  if (worst.troughIndex < 0) {
    return { percent: dec(0), amount: dec(0), recoveryBars: null };
  }

  const recovered = curve.findIndex(
    (point, index) => index > worst.troughIndex && point.equity.greaterThanOrEqualTo(worst.peak),
  );

  return {
    percent: worst.percent,
    amount: worst.amount,
    recoveryBars: recovered === -1 ? null : recovered - worst.peakIndex,
  };
}

/** Bar-to-bar returns of the equity curve, as fractions. */
function periodReturns(curve: EquityPoint[]): Decimal[] {
  const returns: Decimal[] = [];
  for (let i = 1; i < curve.length; i += 1) {
    const previous = curve[i - 1]?.equity;
    const current = curve[i]?.equity;
    if (!previous || !current || previous.lessThanOrEqualTo(0)) continue;
    returns.push(current.minus(previous).div(previous));
  }
  return returns;
}

function periodsPerYearFor(timeframe: Timeframe): number {
  if (timeframe === '1d') return TRADING_DAYS_PER_YEAR;
  const perDay = REGULAR_SESSION_MINUTES / TIMEFRAME_MINUTES[timeframe];
  return perDay * TRADING_DAYS_PER_YEAR;
}

function mean(values: Decimal[]): Decimal {
  if (values.length === 0) return dec(0);
  return sum(values).div(values.length);
}

function sharpeRatio(returns: Decimal[], periodsPerYear: number): string | null {
  const average = mean(returns);
  const variance = mean(returns.map((r) => r.minus(average).pow(2)));
  if (!meaningfulDispersion(variance, average)) return null;
  // Excess over a zero risk-free rate, stated rather than assumed away.
  return average.div(variance.sqrt()).times(dec(periodsPerYear).sqrt()).toString();
}

/**
 * Whether a spread of returns is wide enough to divide by.
 *
 * A constant return stream has no dispersion, so its risk-adjusted return is
 * undefined — but arithmetic at twenty significant digits leaves a residue,
 * and dividing by that residue produces a Sharpe ratio in the quadrillions.
 * A number like that is an artefact of rounding wearing the costume of a
 * measurement, so it is withheld.
 */
function meaningfulDispersion(variance: Decimal, average: Decimal): boolean {
  if (variance.lessThanOrEqualTo(0)) return false;
  const sd = variance.sqrt();
  return sd.greaterThan(average.abs().times(dec('1e-6')));
}

function sortinoRatio(returns: Decimal[], periodsPerYear: number): string | null {
  const average = mean(returns);
  const downside = returns.filter((r) => r.lessThan(0));
  if (downside.length === 0) return null;
  const variance = mean(downside.map((r) => r.pow(2)));
  if (!meaningfulDispersion(variance, average)) return null;
  return average.div(variance.sqrt()).times(dec(periodsPerYear).sqrt()).toString();
}

/** Years between the first and last bar, or null below a month. */
function cagr(initial: Decimal, final: Decimal, curve: EquityPoint[]): string | null {
  const first = curve[0]?.at;
  const last = curve[curve.length - 1]?.at;
  if (!first || !last || initial.lessThanOrEqualTo(0) || final.lessThanOrEqualTo(0)) return null;

  const days = (last.getTime() - first.getTime()) / 86_400_000;
  if (days < 30) return null;

  const years = days / 365.25;
  const growth = Number(final.div(initial).toString());
  return dec((growth ** (1 / years) - 1) * 100).toString();
}

function longestStreak(trades: BacktestTrade[], predicate: (t: BacktestTrade) => boolean): number {
  let longest = 0;
  let current = 0;
  for (const trade of trades) {
    if (predicate(trade)) {
      current += 1;
      if (current > longest) longest = current;
    } else {
      current = 0;
    }
  }
  return longest;
}
