import Decimal from 'decimal.js';
import { dec } from '@zusu/shared';
import type { IndicatorSeries } from '../market-data/indicator.service.js';
import type { ProviderCandle, Timeframe } from '../market-data/types.js';
import type { RiskSettings, StrategyDefinition } from '../strategies/strategy.service.js';
import {
  runBacktest,
  type BacktestCosts,
  type BacktestRun,
  type BacktestTrade,
  type SymbolSeries,
} from './engine.js';
import { computeMetrics, type BacktestMetrics } from './metrics.js';

/**
 * Walk-forward, Monte Carlo and parameter search (§31, §32).
 *
 * Everything in this file exists to answer one question: how much of a good
 * backtest is the strategy, and how much is the sixty attempts it took to find
 * it. The techniques are standard; what matters is that each reports the
 * evidence *against* the result as prominently as the result.
 *
 * Both resampling paths are seeded and deterministic. A Monte Carlo that gives
 * a different answer on each run cannot be reviewed, and "the run I showed you
 * was the good one" is not a defence anybody can check.
 */

const MIN_TRADES_FOR_CONFIDENCE = 30;
/** Below this, out-of-sample performance is treated as unmeasured. */
const MIN_TRADES_PER_FOLD = 5;

export interface AnalysisInput {
  definition: StrategyDefinition;
  riskSettings: RiskSettings;
  initialCapital: Decimal;
  costs: BacktestCosts;
  symbols: SymbolSeries[];
  timeframe: Timeframe;
  /**
   * Recomputes indicators from a slice of candles.
   *
   * Passed in rather than imported so this file stays pure — and required
   * rather than optional, because a fold that reused a series computed over
   * the whole history would be reading its own future.
   */
  seriesFrom: (candles: ProviderCandle[]) => IndicatorSeries;
}

// ---------------------------------------------------------------------------
// Walk-forward
// ---------------------------------------------------------------------------

export interface WalkForwardFold {
  index: number;
  inSampleFrom: Date;
  inSampleTo: Date;
  outOfSampleFrom: Date;
  outOfSampleTo: Date;
  inSampleReturnPct: string;
  outOfSampleReturnPct: string;
  inSampleTrades: number;
  outOfSampleTrades: number;
  /** Null when a fold produced too few trades to compare honestly. */
  degradationPct: string | null;
}

export interface WalkForwardResult {
  folds: WalkForwardFold[];
  /** Mean out-of-sample return across folds that had enough trades. */
  meanOutOfSampleReturnPct: string | null;
  /** How many folds were profitable out of sample. */
  profitableFolds: number;
  comparableFolds: number;
  verdict: string;
}

/**
 * Splits the window into consecutive in-sample/out-of-sample pairs and runs the
 * same definition on each.
 *
 * No parameter is fitted here, which is deliberate: this measures whether the
 * strategy's edge is stable across time, not whether a search can find one.
 * Fitting per fold is what `optimiseParameters` does, and it reports its own
 * degradation.
 */
export function walkForward(
  input: AnalysisInput,
  options: { folds?: number; outOfSampleFraction?: number } = {},
): WalkForwardResult {
  const foldCount = options.folds ?? 4;
  const outFraction = options.outOfSampleFraction ?? 0.3;

  const instants = allInstants(input.symbols);
  const folds: WalkForwardFold[] = [];

  if (instants.length < foldCount * 10) {
    return {
      folds,
      meanOutOfSampleReturnPct: null,
      profitableFolds: 0,
      comparableFolds: 0,
      verdict:
        `Only ${String(instants.length)} bars of history: too few to split into ` +
        `${String(foldCount)} folds. Walk-forward was not run rather than run on slivers.`,
    };
  }

  const foldSize = Math.floor(instants.length / foldCount);
  const outSize = Math.max(1, Math.floor(foldSize * outFraction));
  const inSize = foldSize - outSize;

  for (let i = 0; i < foldCount; i += 1) {
    const inStart = i * foldSize;
    const inEnd = inStart + inSize;
    const outEnd = Math.min(inEnd + outSize, instants.length);
    if (inEnd >= instants.length || inSize < 5) break;

    const inRun = runWindow(input, instants[inStart]!, instants[inEnd - 1]!);
    const outRun = runWindow(input, instants[inEnd]!, instants[outEnd - 1]!);

    const inReturn = dec(inRun.metrics.totalReturnPct);
    const outReturn = dec(outRun.metrics.totalReturnPct);
    const comparable =
      inRun.run.trades.length >= MIN_TRADES_PER_FOLD &&
      outRun.run.trades.length >= MIN_TRADES_PER_FOLD;

    folds.push({
      index: i + 1,
      inSampleFrom: new Date(instants[inStart]!),
      inSampleTo: new Date(instants[inEnd - 1]!),
      outOfSampleFrom: new Date(instants[inEnd]!),
      outOfSampleTo: new Date(instants[outEnd - 1]!),
      inSampleReturnPct: inReturn.toString(),
      outOfSampleReturnPct: outReturn.toString(),
      inSampleTrades: inRun.run.trades.length,
      outOfSampleTrades: outRun.run.trades.length,
      degradationPct: comparable ? inReturn.minus(outReturn).toString() : null,
    });
  }

  const comparable = folds.filter((fold) => fold.degradationPct !== null);
  const meanOut =
    comparable.length > 0
      ? comparable
          .reduce((total, fold) => total.plus(dec(fold.outOfSampleReturnPct)), dec(0))
          .div(comparable.length)
      : null;
  const profitable = folds.filter((fold) => dec(fold.outOfSampleReturnPct).greaterThan(0)).length;

  return {
    folds,
    meanOutOfSampleReturnPct: meanOut ? meanOut.toString() : null,
    profitableFolds: profitable,
    comparableFolds: comparable.length,
    verdict: walkForwardVerdict(folds, comparable.length, profitable, meanOut),
  };
}

function walkForwardVerdict(
  folds: WalkForwardFold[],
  comparable: number,
  profitable: number,
  meanOut: Decimal | null,
): string {
  if (folds.length === 0) return 'No fold produced a comparable window.';
  if (comparable === 0) {
    return (
      `${String(folds.length)} folds ran but none produced at least ` +
      `${String(MIN_TRADES_PER_FOLD)} trades in and out of sample, so nothing here ` +
      'measures stability. Treat the headline result as untested.'
    );
  }
  if (!meanOut) return 'Out-of-sample return could not be summarised.';

  if (meanOut.lessThanOrEqualTo(0)) {
    return (
      `Out of sample the strategy averaged ${meanOut.toFixed(2)}% across ` +
      `${String(comparable)} comparable folds. An edge that appears only in sample is a ` +
      'description of the past, not a strategy.'
    );
  }
  if (profitable * 2 <= folds.length) {
    return (
      `Only ${String(profitable)} of ${String(folds.length)} folds were profitable out of ` +
      'sample. A positive average carried by one fold is one lucky period, not evidence.'
    );
  }
  return (
    `${String(profitable)} of ${String(folds.length)} folds were profitable out of sample, ` +
    `averaging ${meanOut.toFixed(2)}%. Stable across the windows tested — which is not the ` +
    'same as stable in the future.'
  );
}

// ---------------------------------------------------------------------------
// Monte Carlo
// ---------------------------------------------------------------------------

export interface MonteCarloResult {
  iterations: number;
  tradesResampled: number;
  /** Percentiles of terminal equity, as amounts. */
  equityPercentiles: { p5: string; p25: string; p50: string; p75: string; p95: string };
  /** Percentiles of the worst drawdown seen in a resampled sequence. */
  drawdownPercentiles: { p50: string; p75: string; p95: string };
  /** The fraction of resampled sequences that ended below the starting capital. */
  probabilityOfLossPct: string;
  /** The worst drawdown any resampled ordering produced. */
  worstDrawdownPct: string;
  verdict: string;
}

/**
 * Reshuffles and resamples the realised trades to ask what else could have
 * happened in the same market.
 *
 * This is a statement about *sequence risk*, not about the future: the trades
 * are the ones the strategy actually took. Its use is to show that the order
 * in which wins and losses arrived flattered or punished the equity curve —
 * a run of the same trades in a different order can produce a drawdown twice
 * as deep, and a strategy whose survival depends on a lucky ordering is not
 * one to size up.
 */
export function monteCarlo(
  trades: BacktestTrade[],
  options: { initialCapital: Decimal; iterations?: number; seed?: number },
): MonteCarloResult {
  const iterations = options.iterations ?? 1_000;
  const initial = options.initialCapital;

  if (trades.length < 2) {
    return {
      iterations: 0,
      tradesResampled: trades.length,
      equityPercentiles: {
        p5: initial.toString(),
        p25: initial.toString(),
        p50: initial.toString(),
        p75: initial.toString(),
        p95: initial.toString(),
      },
      drawdownPercentiles: { p50: '0', p75: '0', p95: '0' },
      probabilityOfLossPct: '0',
      worstDrawdownPct: '0',
      verdict:
        'Fewer than two trades: there is no sequence to resample. This is not a ' +
        'favourable result, it is an absent one.',
    };
  }

  const random = seededRandom(options.seed ?? 20260101);
  const pnls = trades.map((trade) => trade.netPnl);

  const terminals: Decimal[] = [];
  const drawdowns: Decimal[] = [];
  let losses = 0;

  for (let i = 0; i < iterations; i += 1) {
    let equity = initial;
    let peak = initial;
    let worst = dec(0);

    for (let t = 0; t < pnls.length; t += 1) {
      // Sampling with replacement, so an unlucky run of losses longer than any
      // that actually occurred is possible — which is the point.
      const pick = pnls[Math.floor(random() * pnls.length)] ?? dec(0);
      equity = equity.plus(pick);
      if (equity.greaterThan(peak)) peak = equity;
      if (peak.greaterThan(0)) {
        const fall = peak.minus(equity).div(peak).times(100);
        if (fall.greaterThan(worst)) worst = fall;
      }
    }

    terminals.push(equity);
    drawdowns.push(worst);
    if (equity.lessThan(initial)) losses += 1;
  }

  const sortedEquity = [...terminals].sort((a, b) => a.comparedTo(b));
  const sortedDrawdown = [...drawdowns].sort((a, b) => a.comparedTo(b));
  const worstDrawdown = sortedDrawdown[sortedDrawdown.length - 1] ?? dec(0);
  const probabilityOfLoss = dec(losses).div(iterations).times(100);

  return {
    iterations,
    tradesResampled: trades.length,
    equityPercentiles: {
      p5: percentile(sortedEquity, 5).toString(),
      p25: percentile(sortedEquity, 25).toString(),
      p50: percentile(sortedEquity, 50).toString(),
      p75: percentile(sortedEquity, 75).toString(),
      p95: percentile(sortedEquity, 95).toString(),
    },
    drawdownPercentiles: {
      p50: percentile(sortedDrawdown, 50).toString(),
      p75: percentile(sortedDrawdown, 75).toString(),
      p95: percentile(sortedDrawdown, 95).toString(),
    },
    probabilityOfLossPct: probabilityOfLoss.toString(),
    worstDrawdownPct: worstDrawdown.toString(),
    verdict:
      `In ${String(iterations)} resamplings of these ${String(trades.length)} trades, ` +
      `${probabilityOfLoss.toFixed(1)}% ended below the starting capital and the worst ` +
      `drawdown reached ${worstDrawdown.toFixed(1)}%. Size the position for that number, ` +
      'not for the one the realised ordering happened to produce.',
  };
}

// ---------------------------------------------------------------------------
// Parameter search
// ---------------------------------------------------------------------------

export interface ParameterCandidate {
  /** A label a person can read, e.g. "rsi14 < 25, stop 1.5%". */
  label: string;
  definition: StrategyDefinition;
  riskSettings?: Partial<RiskSettings>;
}

export interface CandidateResult {
  label: string;
  totalReturnPct: string;
  maxDrawdownPct: string;
  tradeCount: number;
  profitFactor: string | null;
  /** Return divided by drawdown — the ranking figure, and a crude one. */
  score: string;
}

export interface OptimisationResult {
  candidates: CandidateResult[];
  best: CandidateResult | null;
  /** Everything that argues against taking the best result at face value. */
  warnings: string[];
}

/**
 * Runs every candidate and ranks them — with the warnings that make the
 * ranking usable.
 *
 * Searching a parameter space finds the best *past*, and the more candidates
 * tried the better that past looks regardless of whether an edge exists. So
 * nothing here is applied automatically: the function returns a ranking and a
 * list of reasons to doubt it, and a person decides.
 */
export function optimiseParameters(
  input: AnalysisInput,
  candidates: ParameterCandidate[],
): OptimisationResult {
  const results: CandidateResult[] = candidates.map((candidate) => {
    const run = runBacktest({
      definition: candidate.definition,
      riskSettings: { ...input.riskSettings, ...candidate.riskSettings },
      initialCapital: input.initialCapital,
      costs: input.costs,
      symbols: input.symbols,
    });
    const metrics = computeMetrics(run, {
      initialCapital: input.initialCapital,
      timeframe: input.timeframe,
    });

    const drawdown = dec(metrics.maxDrawdownPct);
    return {
      label: candidate.label,
      totalReturnPct: metrics.totalReturnPct,
      maxDrawdownPct: metrics.maxDrawdownPct,
      tradeCount: metrics.tradeCount,
      profitFactor: metrics.profitFactor,
      score: drawdown.greaterThan(0)
        ? dec(metrics.totalReturnPct).div(drawdown).toString()
        : metrics.totalReturnPct,
    };
  });

  const ranked = [...results].sort((a, b) => dec(b.score).comparedTo(dec(a.score)));
  const best = ranked[0] ?? null;

  return { candidates: ranked, best, warnings: overfittingWarnings(ranked, candidates.length) };
}

function overfittingWarnings(ranked: CandidateResult[], tried: number): string[] {
  const warnings: string[] = [];
  const best = ranked[0];
  if (!best) return ['No candidate produced a result.'];

  if (tried > 1) {
    warnings.push(
      `${String(tried)} parameter sets were tried. The best of many is partly a measure of ` +
        'how many were tried: the more candidates, the better the winner looks whether or ' +
        'not an edge exists.',
    );
  }

  if (best.tradeCount < MIN_TRADES_FOR_CONFIDENCE) {
    warnings.push(
      `The best candidate made ${String(best.tradeCount)} trades. Below ` +
        `${String(MIN_TRADES_FOR_CONFIDENCE)} the difference between candidates is mostly ` +
        'noise, and a ranking of noise is still a ranking.',
    );
  }

  const scores = ranked.map((candidate) => dec(candidate.score));
  const median = percentile(
    [...scores].sort((a, b) => a.comparedTo(b)),
    50,
  );
  if (median.abs().greaterThan(0) && dec(best.score).greaterThan(median.times(3))) {
    warnings.push(
      'The best candidate scores more than three times the median. A sharp peak in a ' +
        'parameter surface is usually a coincidence that fits this data; a real edge tends ' +
        'to show as a plateau.',
    );
  }

  // Neighbour stability: the ranking is in score order, so the runner-up is the
  // most generous available comparison.
  const second = ranked[1];
  if (second && dec(second.score).lessThan(dec(best.score).div(2))) {
    warnings.push(
      `The second-best candidate ("${second.label}") scores less than half the best. If a ` +
        'small change in a parameter halves the result, the parameter is fitted to this ' +
        'sample rather than to the market.',
    );
  }

  const losers = ranked.filter((candidate) => dec(candidate.totalReturnPct).lessThanOrEqualTo(0));
  if (losers.length * 2 > ranked.length) {
    warnings.push(
      `${String(losers.length)} of ${String(ranked.length)} candidates lost money. The ` +
        'winner is being drawn from a mostly unprofitable family.',
    );
  }

  return warnings;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Every bar open time across all symbols, ascending and de-duplicated. */
function allInstants(symbols: SymbolSeries[]): number[] {
  const set = new Set<number>();
  for (const entry of symbols) {
    for (const candle of entry.candles) set.add(candle.openTime.getTime());
  }
  return [...set].sort((a, b) => a - b);
}

/**
 * Re-runs the backtest over a slice of the window.
 *
 * The indicator series is recomputed from the sliced candles rather than
 * indexed into the full one, which is what makes a fold honest: a fold that
 * borrowed a 50-period average computed over the whole history would be using
 * information from its own future.
 */
function runWindow(
  input: AnalysisInput,
  from: number,
  to: number,
): { run: BacktestRun; metrics: BacktestMetrics } {
  const symbols = input.symbols.map((entry) => {
    const candles = entry.candles.filter((candle) => {
      const time = candle.openTime.getTime();
      return time >= from && time <= to;
    });
    return { symbol: entry.symbol, candles, series: input.seriesFrom(candles) };
  });

  const run = runBacktest({
    definition: input.definition,
    riskSettings: input.riskSettings,
    initialCapital: input.initialCapital,
    costs: input.costs,
    symbols,
  });

  return {
    run,
    metrics: computeMetrics(run, {
      initialCapital: input.initialCapital,
      timeframe: input.timeframe,
    }),
  };
}

/** Linear-interpolation-free percentile: the nearest rank, which is enough here. */
function percentile(sorted: Decimal[], p: number): Decimal {
  if (sorted.length === 0) return dec(0);
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index] ?? dec(0);
}

/**
 * A seeded generator, so every resampling is reproducible.
 *
 * `Math.random` would make a Monte Carlo result unreviewable: nobody could
 * reproduce the run that produced the number in the report.
 */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    // mulberry32: small, fast, and adequate for resampling a trade list.
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
