import type { Prisma, PrismaClient } from '@prisma/client';
import Decimal from 'decimal.js';
import { dec } from '@zusu/shared';
import { AppError } from '../../lib/errors.js';
import { RANGE_ROW_CAP, type IndicatorService } from '../market-data/indicator.service.js';
import type { WatchlistService } from '../market-data/watchlist.service.js';

import type { StrategyService } from '../strategies/strategy.service.js';
import {
  monteCarlo,
  optimiseParameters,
  walkForward,
  type AnalysisInput,
  type MonteCarloResult,
  type OptimisationResult,
  type ParameterCandidate,
  type WalkForwardResult,
} from './analysis.js';
import { DEFAULT_COSTS, runBacktest, type BacktestCosts, type SymbolSeries } from './engine.js';
import { computeMetrics, type BacktestMetrics } from './metrics.js';

/**
 * Running and storing backtests (§29–§32).
 *
 * The engine is pure; this is the part that talks to the database. Three rules
 * shape it:
 *
 *   1. **A backtest names the version it ran, not the strategy.** A strategy's
 *      rules change by adding versions, so "we backtested this strategy" is
 *      meaningless — the row records `strategyVersionId`, and since a version
 *      is immutable the run stays reproducible forever.
 *
 *   2. **A stored result carries its own assumptions.** The costs, the
 *      universe and the capital are written into `parameters`, because a
 *      result read six months later without them is a number with no claim
 *      attached.
 *
 *   3. **Nothing here promotes anything.** Optimisation returns a ranking and
 *      its warnings; a person decides what becomes a version. There is no code
 *      path from a good backtest to a live strategy.
 */

export interface BacktestCostInput {
  commissionPerTrade?: string;
  commissionPerShare?: string;
  spreadFraction?: string;
  slippageFraction?: string;
}

export interface RunBacktestInput {
  strategyVersionId: string;
  from: Date;
  to: Date;
  initialCapital?: string;
  costs?: BacktestCostInput;
  portfolioId?: string | null;
  requestedById?: string | null;
  /** Skips the walk-forward and Monte Carlo passes, which dominate the runtime. */
  quick?: boolean;
  monteCarloSeed?: number;
}

export interface BacktestSummary {
  id: string;
  strategyId: string;
  strategyVersionId: string;
  strategyName: string;
  version: number;
  status: string;
  timeframe: string;
  startDate: Date;
  endDate: Date;
  initialCapital: string;
  parameters: StoredParameters;
  metrics: BacktestMetrics | null;
  walkForward: WalkForwardResult | null;
  monteCarlo: MonteCarloResult | null;
  /** Thinned to at most 500 points; the first and last are always kept. */
  equityCurve: { at: string; equity: string }[];
  /** Entry signals the run could not act on, each with why. */
  skips: { at: string; symbol: string; reason: string }[];
  errorMessage: string | null;
  createdAt: Date;
  finishedAt: Date | null;
  tradeCount: number;
}

export interface StoredParameters {
  universe: string[];
  barsLoaded: number;
  /**
   * The span actually covered by the bars that were read.
   *
   * Reported separately from the requested window because they can differ —
   * history may start later than the request — and a result labelled with a
   * window it did not read is a mislabelled result.
   */
  windowUsed: { from: string; to: string } | null;
  costs: {
    commissionPerTrade: string;
    commissionPerShare: string;
    spreadFraction: string;
    slippageFraction: string;
  };
  /** Every assumption the engine makes, restated where a reader will see it. */
  assumptions: string[];
}

const ASSUMPTIONS = [
  'A decision on a closed bar fills at the next bar’s open, never at that bar’s close.',
  'A stop or target fills at its own price, except on a bar that gaps through it, which fills at the open.',
  'A bar containing both the stop and the target resolves as the stop; those bars are counted.',
  'Commission, half the spread and a slippage fraction are charged on every fill.',
  'Positions still open at the end of the window are closed at the last close and labelled as such.',
  'Position size is capped by the version’s maximum notional and by available cash; whole shares only.',
];

export class BacktestService {
  constructor(
    private readonly db: PrismaClient,
    private readonly strategies: StrategyService,
    private readonly indicators: IndicatorService,
    private readonly watchlists: WatchlistService,
  ) {}

  async list(options: { strategyId?: string; limit?: number } = {}): Promise<BacktestSummary[]> {
    const rows = await this.db.backtest.findMany({
      where: options.strategyId ? { strategyId: options.strategyId } : {},
      orderBy: { createdAt: 'desc' },
      take: options.limit ?? 25,
      include: {
        strategy: { select: { name: true } },
        strategyVersion: { select: { version: true } },
        _count: { select: { trades: true } },
      },
    });
    return rows.map((row) => this.toSummary(row));
  }

  async get(id: string): Promise<BacktestSummary & { trades: StoredTrade[] }> {
    const row = await this.db.backtest.findUnique({
      where: { id },
      include: {
        strategy: { select: { name: true } },
        strategyVersion: { select: { version: true } },
        trades: { orderBy: { entryTime: 'asc' } },
        _count: { select: { trades: true } },
      },
    });
    if (!row) throw new AppError('NOT_FOUND', 'Backtest not found');

    return {
      ...this.toSummary(row),
      trades: row.trades.map((trade) => ({
        symbol: trade.symbol,
        direction: trade.direction,
        quantity: trade.quantity.toString(),
        entryTime: trade.entryTime,
        entryPrice: trade.entryPrice.toString(),
        exitTime: trade.exitTime,
        exitPrice: trade.exitPrice ? trade.exitPrice.toString() : null,
        grossPnl: trade.grossPnl ? trade.grossPnl.toString() : null,
        fees: trade.fees.toString(),
        slippage: trade.slippage.toString(),
        netPnl: trade.netPnl ? trade.netPnl.toString() : null,
        rMultiple: trade.rMultiple ? trade.rMultiple.toString() : null,
        maeAmount: trade.maeAmount ? trade.maeAmount.toString() : null,
        mfeAmount: trade.mfeAmount ? trade.mfeAmount.toString() : null,
        exitReason: trade.exitReason,
      })),
    };
  }

  /**
   * Runs a backtest synchronously and stores it.
   *
   * Synchronous on purpose for now: a run over a few thousand bars takes
   * milliseconds, and a queue whose worker does not exist yet would be a
   * `QUEUED` row that never becomes anything. The status column is honest
   * about what happened either way.
   */
  async run(input: RunBacktestInput): Promise<BacktestSummary> {
    const version = await this.loadVersion(input.strategyVersionId);
    const definition = version.definition;
    const riskSettings = version.riskSettings;

    if (!definition || !riskSettings) {
      throw new AppError(
        'CONFLICT',
        `Version ${String(version.version)} was written in a rule language this build ` +
          'cannot read, so it cannot be backtested.',
      );
    }

    if (input.from.getTime() >= input.to.getTime()) {
      throw new AppError('VALIDATION_FAILED', 'The window must start before it ends');
    }

    const timeframe = definition.timeframe;
    const costs = resolveCosts(input.costs);
    const initialCapital = dec(input.initialCapital ?? '100000');
    if (initialCapital.lessThanOrEqualTo(0)) {
      throw new AppError('VALIDATION_FAILED', 'Initial capital must be positive');
    }

    const universe = await this.watchlists.symbolsFor(definition.watchlistId);
    const symbols: SymbolSeries[] = [];
    let barsLoaded = 0;
    let earliest: Date | null = null;
    let latest: Date | null = null;

    for (const symbol of universe) {
      const candles = await this.indicators.loadCandles(symbol, timeframe, {
        from: input.from,
        to: input.to,
      });
      if (candles.length === 0) continue;
      if (candles.length >= RANGE_ROW_CAP) {
        throw new AppError(
          'VALIDATION_FAILED',
          `${symbol} alone has ${String(RANGE_ROW_CAP)} or more bars in this window, which is ` +
            'more than one pass can read. Narrow the window — a backtest over a window it ' +
            'could not fully read would be mislabelled.',
        );
      }
      barsLoaded += candles.length;
      const first = candles[0]?.openTime;
      const last = candles[candles.length - 1]?.openTime;
      if (first && (!earliest || first < earliest)) earliest = first;
      if (last && (!latest || last > latest)) latest = last;
      symbols.push({ symbol, candles, series: this.indicators.seriesFrom(candles) });
    }

    const parameters: StoredParameters = {
      universe: symbols.map((entry) => entry.symbol),
      barsLoaded,
      windowUsed:
        earliest && latest ? { from: earliest.toISOString(), to: latest.toISOString() } : null,
      costs: {
        commissionPerTrade: costs.commissionPerTrade.toString(),
        commissionPerShare: costs.commissionPerShare.toString(),
        spreadFraction: costs.spreadFraction.toString(),
        slippageFraction: costs.slippageFraction.toString(),
      },
      assumptions: ASSUMPTIONS,
    };

    // The row is created before the run, so a crash leaves a FAILED row with
    // its reason rather than no trace that anything was attempted.
    const created = await this.db.backtest.create({
      data: {
        strategyId: version.strategyId,
        strategyVersionId: version.id,
        portfolioId: input.portfolioId ?? null,
        requestedById: input.requestedById ?? null,
        status: 'RUNNING',
        timeframe,
        startDate: input.from,
        endDate: input.to,
        initialCapital: initialCapital.toString(),
        parameters: parameters as unknown as Prisma.InputJsonValue,
        startedAt: new Date(),
      },
    });

    if (symbols.length === 0) {
      await this.db.backtest.update({
        where: { id: created.id },
        data: {
          status: 'FAILED',
          errorMessage:
            'No stored bars in this window for any symbol in the universe. ' +
            'Backfill the history first — an empty backtest is not a flat result.',
          finishedAt: new Date(),
        },
      });
      return this.get(created.id).then((summary) => summary);
    }

    try {
      const analysisInput: AnalysisInput = {
        definition,
        riskSettings,
        initialCapital,
        costs,
        symbols,
        timeframe,
        seriesFrom: (slice) => this.indicators.seriesFrom(slice),
      };

      const run = runBacktest(analysisInput);
      const metrics = computeMetrics(run, { initialCapital, timeframe });
      const forward = input.quick ? null : walkForward(analysisInput);
      const carlo = input.quick
        ? null
        : monteCarlo(run.trades, {
            initialCapital,
            ...(input.monteCarloSeed !== undefined && { seed: input.monteCarloSeed }),
          });

      await this.db.$transaction([
        this.db.backtest.update({
          where: { id: created.id },
          data: {
            status: 'COMPLETED',
            finishedAt: new Date(),
            results: {
              metrics,
              walkForward: forward,
              monteCarlo: carlo,
              skips: run.skips.slice(0, 200).map((skip) => ({
                at: skip.at.toISOString(),
                symbol: skip.symbol,
                reason: skip.reason,
              })),
              equityCurve: sampleCurve(run.equityCurve),
            } as unknown as Prisma.InputJsonValue,
          },
        }),
        this.db.backtestTrade.createMany({
          data: run.trades.map((trade) => ({
            backtestId: created.id,
            symbol: trade.symbol,
            direction: trade.direction,
            quantity: trade.quantity.toString(),
            entryTime: trade.entryTime,
            entryPrice: trade.entryPrice.toString(),
            exitTime: trade.exitTime,
            exitPrice: trade.exitPrice.toString(),
            grossPnl: trade.grossPnl.toString(),
            fees: trade.fees.toString(),
            slippage: trade.slippage.toString(),
            netPnl: trade.netPnl.toString(),
            rMultiple: trade.rMultiple ? trade.rMultiple.toString() : null,
            maeAmount: trade.maeAmount.toString(),
            mfeAmount: trade.mfeAmount.toString(),
            exitReason: trade.exitReason,
          })),
        }),
      ]);
    } catch (error) {
      await this.db.backtest.update({
        where: { id: created.id },
        data: {
          status: 'FAILED',
          errorMessage: error instanceof Error ? error.message : 'Unknown failure',
          finishedAt: new Date(),
        },
      });
      throw error;
    }

    return this.get(created.id);
  }

  /**
   * Ranks candidate parameter sets over one window.
   *
   * Deliberately does not store anything. An optimisation is a search of the
   * past; writing its winner into a version would be the platform choosing
   * rules on the strength of a search, which is exactly the decision a person
   * is supposed to make.
   */
  async optimise(input: {
    strategyVersionId: string;
    from: Date;
    to: Date;
    candidates: ParameterCandidate[];
    initialCapital?: string;
    costs?: BacktestCostInput;
  }): Promise<OptimisationResult> {
    const version = await this.loadVersion(input.strategyVersionId);
    if (!version.definition || !version.riskSettings) {
      throw new AppError('CONFLICT', 'This version’s rule language cannot be read by this build');
    }
    if (input.candidates.length === 0) {
      throw new AppError('VALIDATION_FAILED', 'Give at least one candidate to compare');
    }

    const universe = await this.watchlists.symbolsFor(version.definition.watchlistId);
    const symbols: SymbolSeries[] = [];
    for (const symbol of universe) {
      const candles = await this.indicators.loadCandles(symbol, version.definition.timeframe, {
        from: input.from,
        to: input.to,
      });
      if (candles.length === 0) continue;
      symbols.push({ symbol, candles, series: this.indicators.seriesFrom(candles) });
    }
    if (symbols.length === 0) {
      throw new AppError('VALIDATION_FAILED', 'No stored bars in this window to optimise over');
    }

    return optimiseParameters(
      {
        definition: version.definition,
        riskSettings: version.riskSettings,
        initialCapital: dec(input.initialCapital ?? '100000'),
        costs: resolveCosts(input.costs),
        symbols,
        timeframe: version.definition.timeframe,
        seriesFrom: (slice) => this.indicators.seriesFrom(slice),
      },
      input.candidates,
    );
  }

  private async loadVersion(id: string) {
    const row = await this.db.strategyVersion.findUnique({ where: { id } });
    if (!row) throw new AppError('NOT_FOUND', 'Strategy version not found');
    const strategy = await this.strategies.get(row.strategyId);
    const version = strategy.versions.find((candidate) => candidate.id === id);
    if (!version) throw new AppError('NOT_FOUND', 'Strategy version not found');
    return version;
  }

  private toSummary(row: {
    id: string;
    strategyId: string;
    strategyVersionId: string;
    status: string;
    timeframe: string;
    startDate: Date;
    endDate: Date;
    initialCapital: Decimal;
    parameters: unknown;
    results: unknown;
    errorMessage: string | null;
    createdAt: Date;
    finishedAt: Date | null;
    strategy: { name: string };
    strategyVersion: { version: number };
    _count: { trades: number };
  }): BacktestSummary {
    const results = (row.results ?? null) as {
      metrics?: BacktestMetrics;
      walkForward?: WalkForwardResult;
      monteCarlo?: MonteCarloResult;
      equityCurve?: { at: string; equity: string }[];
      skips?: { at: string; symbol: string; reason: string }[];
    } | null;

    return {
      id: row.id,
      strategyId: row.strategyId,
      strategyVersionId: row.strategyVersionId,
      strategyName: row.strategy.name,
      version: row.strategyVersion.version,
      status: row.status,
      timeframe: row.timeframe,
      startDate: row.startDate,
      endDate: row.endDate,
      initialCapital: row.initialCapital.toString(),
      parameters: row.parameters as StoredParameters,
      metrics: results?.metrics ?? null,
      walkForward: results?.walkForward ?? null,
      monteCarlo: results?.monteCarlo ?? null,
      equityCurve: results?.equityCurve ?? [],
      skips: results?.skips ?? [],
      errorMessage: row.errorMessage,
      createdAt: row.createdAt,
      finishedAt: row.finishedAt,
      tradeCount: row._count.trades,
    };
  }
}

export interface StoredTrade {
  symbol: string;
  direction: string;
  quantity: string;
  entryTime: Date;
  entryPrice: string;
  exitTime: Date | null;
  exitPrice: string | null;
  grossPnl: string | null;
  fees: string;
  slippage: string;
  netPnl: string | null;
  rMultiple: string | null;
  maeAmount: string | null;
  mfeAmount: string | null;
  exitReason: string | null;
}

function resolveCosts(input: BacktestCostInput | undefined): BacktestCosts {
  return {
    commissionPerTrade: input?.commissionPerTrade
      ? dec(input.commissionPerTrade)
      : DEFAULT_COSTS.commissionPerTrade,
    commissionPerShare: input?.commissionPerShare
      ? dec(input.commissionPerShare)
      : DEFAULT_COSTS.commissionPerShare,
    spreadFraction: input?.spreadFraction
      ? dec(input.spreadFraction)
      : DEFAULT_COSTS.spreadFraction,
    slippageFraction: input?.slippageFraction
      ? dec(input.slippageFraction)
      : DEFAULT_COSTS.slippageFraction,
  };
}

/**
 * Thins the equity curve to at most 500 points for storage.
 *
 * Peaks and troughs are what a reader looks for, so the samples are taken at
 * a fixed stride with the first and last always kept: a curve summarised by
 * averaging would hide the drawdown that the metrics report.
 */
const MAX_CURVE_POINTS = 500;

function sampleCurve(
  curve: { at: Date; equity: Decimal; cash: Decimal; openPositions: number }[],
): { at: string; equity: string }[] {
  if (curve.length <= MAX_CURVE_POINTS) {
    return curve.map((point) => ({ at: point.at.toISOString(), equity: point.equity.toString() }));
  }
  const stride = Math.ceil(curve.length / MAX_CURVE_POINTS);
  const sampled = curve.filter((_, index) => index % stride === 0);
  const last = curve[curve.length - 1];
  if (last && sampled[sampled.length - 1] !== last) sampled.push(last);
  return sampled.map((point) => ({ at: point.at.toISOString(), equity: point.equity.toString() }));
}
