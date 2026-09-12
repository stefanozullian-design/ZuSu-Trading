import { Prisma, type PrismaClient } from '@prisma/client';
import {
  AssetClass,
  MarketSession,
  SignalDirection,
  SignalStatus,
  StrategyStage,
  TradingSessionScope,
  dec,
  type Decimal,
} from '@zusu/shared';
import { randomUUID } from 'node:crypto';
import { AppError } from '../../lib/errors.js';
import type { MarketCalendarService } from '../market-data/calendar.service.js';
import type { IndicatorSeries, IndicatorService } from '../market-data/indicator.service.js';
import { TIMEFRAME_MINUTES, type Timeframe } from '../market-data/types.js';
import type { WatchlistService } from '../market-data/watchlist.service.js';
import { evaluateRule, type RuleTrace } from './rule-tree.js';
import type {
  RiskSettings,
  StrategyDefinition,
  StrategyService,
  StrategyVersionView,
} from './strategy.service.js';

/**
 * The signal engine (§11).
 *
 * Evaluates a live strategy version over its universe and records a signal
 * where the entry rule fires. A signal is a *recommendation*: it is created at
 * status CREATED and nothing here can advance it toward an order. The risk
 * engine (Phase 7) and the order manager (Phase 8) own that, which is why this
 * module cannot reach a broker even in principle.
 *
 * The guarantee that matters is deduplication. "The same market event never
 * produces two signals" is enforced by a unique index on `signals.signal_key`,
 * not by a check-then-insert — two concurrent evaluations would both pass a
 * check and both insert. The key is derived from (strategy version, portfolio,
 * symbol, bar), so re-running an evaluation over the same closed bar is a
 * no-op however many times it happens and however many workers do it at once.
 */

export interface SignalKeyParts {
  strategyName: string;
  version: number;
  symbol: string;
  portfolioId: string;
  barOpenTime: Date;
}

/**
 * The dedupe key.
 *
 * Deliberately readable rather than a hash: when a duplicate is refused, the
 * key is what a person sees, and `RSI_BOUNCE_v3:AAPL:…:2026-09-09T14:30Z` says
 * what happened where a digest would not.
 */
export function signalKeyFor(parts: SignalKeyParts): string {
  const slug = parts.strategyName
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  // Minute precision: a bar is identified by its open time, and seconds would
  // differ between a live evaluation and a replay of the same bar.
  const bar = parts.barOpenTime.toISOString().slice(0, 16) + 'Z';
  return `${slug}_v${String(parts.version)}:${parts.symbol}:${parts.portfolioId}:${bar}`;
}

export interface EvaluationSkip {
  symbol: string;
  reason: string;
}

export interface EvaluationResult {
  strategyId: string;
  strategyVersionId: string;
  version: number;
  timeframe: Timeframe;
  correlationId: string;
  /** Signals created by this run. */
  created: { id: string; signalKey: string; symbol: string; direction: SignalDirection }[];
  /** Symbols whose rule fired but whose signal already existed. */
  duplicates: string[];
  /** Symbols the rule said no to. */
  rejected: string[];
  /** Symbols that could not be judged, with why. Never silently dropped. */
  notEvaluable: EvaluationSkip[];
  evaluatedAt: Date;
}

export class SignalService {
  constructor(
    private readonly db: PrismaClient,
    private readonly strategies: StrategyService,
    private readonly indicators: IndicatorService,
    private readonly watchlists: WatchlistService,
    private readonly calendar: MarketCalendarService,
    /**
     * Optional: a signal that nobody is told about still exists and still
     * waits, so a missing notifier must not stop one being recorded.
     */
    private readonly notifications?: {
      notifySafe(input: {
        portfolioId: string;
        event: string;
        title: string;
        body: string;
        metadata?: Record<string, unknown>;
      }): Promise<void>;
    },
  ) {}

  /**
   * Evaluates one strategy version for one portfolio.
   *
   * `at` is the instant the evaluation claims to be for, and it is an input so
   * a run is reproducible: a signal engine that read the wall clock could not
   * be replayed, and a signal nobody can reproduce is a signal nobody can
   * check.
   */
  async evaluate(input: {
    strategyVersionId: string;
    portfolioId: string;
    at?: Date;
    /** Evaluate regardless of stage. For dry runs from the UI. */
    allowNonLive?: boolean;
  }): Promise<EvaluationResult> {
    const at = input.at ?? new Date();
    const correlationId = randomUUID();

    const versionRow = await this.db.strategyVersion.findUnique({
      where: { id: input.strategyVersionId },
      include: { strategy: true },
    });
    if (!versionRow) throw new AppError('NOT_FOUND', 'Strategy version not found');

    const strategy = await this.strategies.get(versionRow.strategyId);
    const version = strategy.versions.find((v) => v.id === input.strategyVersionId);
    if (!version) throw new AppError('NOT_FOUND', 'Strategy version not found');

    if (!input.allowNonLive && version.stage !== StrategyStage.LIVE) {
      throw new AppError(
        'CONFLICT',
        `Version ${String(version.version)} is ${version.stage}, not LIVE. ` +
          'Only a live version produces signals; use a dry run to try a draft.',
      );
    }

    if (!version.definition || !version.riskSettings) {
      // An immutable version written by an older build. Guessing at what it
      // meant would be worse than refusing to run it.
      throw new AppError(
        'CONFLICT',
        `Version ${String(version.version)} was written in a rule language this build ` +
          'cannot read, so it cannot be evaluated.',
      );
    }
    const definition = version.definition;
    const riskSettings = version.riskSettings;

    const portfolio = await this.db.portfolio.findUnique({ where: { id: input.portfolioId } });
    if (!portfolio) throw new AppError('NOT_FOUND', 'Portfolio not found');

    const result: EvaluationResult = {
      strategyId: strategy.id,
      strategyVersionId: version.id,
      version: version.version,
      timeframe: definition.timeframe,
      correlationId,
      created: [],
      duplicates: [],
      rejected: [],
      notEvaluable: [],
      evaluatedAt: at,
    };

    const symbols = await this.watchlists.symbolsFor(definition.watchlistId);
    if (symbols.length === 0) {
      result.notEvaluable.push({
        symbol: '(universe)',
        reason: 'the strategy’s universe is empty, so there was nothing to evaluate',
      });
      return result;
    }

    for (const symbol of symbols) {
      await this.evaluateSymbol({
        symbol,
        version,
        definition,
        riskSettings,
        strategyName: strategy.name,
        portfolioId: input.portfolioId,
        at,
        correlationId,
        result,
      });
    }

    return result;
  }

  /** Evaluates every live version against the portfolios it is enabled for. */
  async evaluateAllLive(at?: Date): Promise<EvaluationResult[]> {
    const configs = await this.db.strategyPortfolioConfig.findMany({
      where: { isEnabled: true, strategyVersion: { stage: StrategyStage.LIVE } },
    });

    const results: EvaluationResult[] = [];
    for (const config of configs) {
      results.push(
        await this.evaluate({
          strategyVersionId: config.strategyVersionId,
          portfolioId: config.portfolioId,
          ...(at ? { at } : {}),
        }),
      );
    }
    return results;
  }

  private async evaluateSymbol(args: {
    symbol: string;
    version: StrategyVersionView;
    /** Passed separately because the caller has already proved it is readable. */
    definition: StrategyDefinition;
    riskSettings: RiskSettings;
    strategyName: string;
    portfolioId: string;
    at: Date;
    correlationId: string;
    result: EvaluationResult;
  }): Promise<void> {
    const { symbol, version, definition, riskSettings, result } = args;

    const series = await this.indicators.series(symbol, definition.timeframe, {
      limit: Math.max(riskSettings.minBars, 200),
    });

    if (series.length < riskSettings.minBars) {
      result.notEvaluable.push({
        symbol,
        reason:
          `only ${String(series.length)} bars stored; this version needs ` +
          `${String(riskSettings.minBars)} before it may say anything`,
      });
      return;
    }

    const barIndex = series.length - 1;
    const barOpenTime = series.openTime[barIndex];
    if (!barOpenTime) {
      result.notEvaluable.push({ symbol, reason: 'the latest bar has no open time' });
      return;
    }

    // A live evaluation must not judge a stale bar. Evaluating Friday's last
    // candle on Sunday would produce a recommendation about a market that has
    // not been open since — the bar is real, but the answer is about the past.
    // Five intervals of slack absorbs a late-arriving candle without letting a
    // weekend through.
    const staleAfterMs = TIMEFRAME_MINUTES[definition.timeframe] * 60_000 * 5;
    const ageMs = args.at.getTime() - barOpenTime.getTime();
    if (ageMs > staleAfterMs) {
      result.notEvaluable.push({
        symbol,
        reason:
          `the newest ${definition.timeframe} bar opened ${formatAge(ageMs)} ago, ` +
          'too old to judge as current',
      });
      return;
    }

    // Session scope is checked against the calendar, not against a guess about
    // the clock. A strategy restricted to regular hours must not fire on a
    // pre-market bar just because that bar happens to be the newest one.
    const session = await this.sessionFor(symbol, barOpenTime);
    if (!this.sessionAllowed(version.sessionScope, session)) {
      result.notEvaluable.push({
        symbol,
        reason: `the latest bar is a ${session} bar, outside this version’s ${version.sessionScope} scope`,
      });
      return;
    }

    const evaluation = evaluateRule(definition.entry.when, series, barIndex);

    if (evaluation.satisfied === null) {
      result.notEvaluable.push({
        symbol,
        reason:
          firstUnknownReason(evaluation.trace) ??
          `the rule could not be judged (missing: ${evaluation.missingFields.join(', ')})`,
      });
      return;
    }
    if (!evaluation.shouldFire) {
      result.rejected.push(symbol);
      return;
    }

    const referencePrice = series.close[barIndex];
    if (!referencePrice) {
      // The rule fired but there is no price to reference. Recording a signal
      // without one would produce a recommendation nothing could act on.
      result.notEvaluable.push({
        symbol,
        reason: 'the rule fired but the latest bar has no close price',
      });
      return;
    }

    const signalKey = signalKeyFor({
      strategyName: args.strategyName,
      version: version.version,
      symbol,
      portfolioId: args.portfolioId,
      barOpenTime,
    });

    const instrument = await this.db.instrument.findUnique({
      where: { symbol },
      select: { assetClass: true },
    });

    try {
      const created = await this.db.signal.create({
        data: {
          signalKey,
          correlationId: args.correlationId,
          portfolioId: args.portfolioId,
          strategyId: version.strategyId,
          strategyVersionId: version.id,
          symbol,
          assetClass: (instrument?.assetClass ?? AssetClass.EQUITY) as AssetClass,
          direction: definition.entry.direction as SignalDirection,
          status: SignalStatus.CREATED,
          referencePrice: referencePrice.toString(),
          suggestedStop: this.stopFor(definition, referencePrice, series, barIndex),
          suggestedTarget: this.targetFor(definition, referencePrice, series, barIndex),
          // The whole trace, so the decision is reconstructible afterwards.
          conditionSnapshot: {
            barOpenTime: barOpenTime.toISOString(),
            timeframe: definition.timeframe,
            session,
            entrySummary: version.entrySummary,
            values: evaluation.values,
            trace: evaluation.trace,
          } as unknown as Prisma.InputJsonValue,
          events: {
            create: {
              // No `fromStatus`: this is the signal coming into existence, not
              // a transition from an earlier state.
              toStatus: SignalStatus.CREATED,
              reason: `Entry rule satisfied: ${version.entrySummary}`,
              actor: `strategy:${args.strategyName} v${String(version.version)}`,
            },
          },
        },
      });

      result.created.push({
        id: created.id,
        signalKey,
        symbol,
        direction: definition.entry.direction as SignalDirection,
      });

      // A recommendation is only useful if somebody knows it is waiting. The
      // notification never changes the signal's status: it is a nudge, not an
      // approval.
      await this.notifications?.notifySafe({
        portfolioId: args.portfolioId,
        event: 'SIGNAL_AWAITING_APPROVAL',
        title: `${symbol} ${definition.entry.direction} — waiting for a decision`,
        body:
          `${args.strategyName} produced a recommendation at ` +
          `${referencePrice.toString()}. It will sit there until somebody approves or ` +
          'rejects it.',
        metadata: { signalId: created.id, symbol },
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        // The dedupe guarantee, arriving from the database rather than from a
        // check this code performed. Two concurrent runs both reach here and
        // exactly one wins.
        result.duplicates.push(symbol);
        return;
      }
      throw error;
    }
  }

  /** The stop price a signal suggests, from the version's stop configuration. */
  private stopFor(
    definition: StrategyDefinition,
    price: Decimal,
    series: IndicatorSeries,
    index: number,
  ): string | null {
    if (!definition.stop) return null;
    const long = definition.entry.direction === 'LONG';

    if (definition.stop.kind === 'PERCENT') {
      const move = price.times(dec(definition.stop.value)).div(100);
      return (long ? price.minus(move) : price.plus(move)).toString();
    }

    const atr = series.atr14[index] ?? null;
    // An ATR stop with no ATR is not a stop. Null rather than a fabricated one.
    if (!atr) return null;
    const move = atr.times(dec(definition.stop.value));
    return (long ? price.minus(move) : price.plus(move)).toString();
  }

  private targetFor(
    definition: StrategyDefinition,
    price: Decimal,
    series: IndicatorSeries,
    index: number,
  ): string | null {
    if (!definition.target) return null;
    const long = definition.entry.direction === 'LONG';
    const multiplier = dec(definition.target.value);

    if (definition.target.kind === 'PERCENT') {
      const move = price.times(multiplier).div(100);
      return (long ? price.plus(move) : price.minus(move)).toString();
    }

    if (definition.target.kind === 'ATR') {
      const atr = series.atr14[index] ?? null;
      if (!atr) return null;
      const move = atr.times(multiplier);
      return (long ? price.plus(move) : price.minus(move)).toString();
    }

    // RISK_MULTIPLE is expressed against the stop distance, so without a stop
    // there is nothing to multiply.
    const stop = this.stopFor(definition, price, series, index);
    if (!stop) return null;
    const distance = price.minus(dec(stop)).abs();
    const move = distance.times(multiplier);
    return (long ? price.plus(move) : price.minus(move)).toString();
  }

  private async sessionFor(symbol: string, at: Date): Promise<MarketSession> {
    const verdict = await this.calendar.isTradable(symbol, at);
    return verdict.session;
  }

  private sessionAllowed(scope: TradingSessionScope, session: MarketSession): boolean {
    if (session === MarketSession.HALTED || session === MarketSession.CLOSED) return false;
    switch (scope) {
      case TradingSessionScope.REGULAR_ONLY:
        return session === MarketSession.REGULAR;
      case TradingSessionScope.INCLUDE_PRE_MARKET:
        return session === MarketSession.REGULAR || session === MarketSession.PRE_MARKET;
      case TradingSessionScope.INCLUDE_AFTER_HOURS:
        return session === MarketSession.REGULAR || session === MarketSession.AFTER_HOURS;
      default:
        return true;
    }
  }
}

/** The deepest reason a branch could not be judged, for a readable message. */
function firstUnknownReason(trace: RuleTrace): string | null {
  if (trace.satisfied !== null) return null;
  if (trace.unknownReason) return trace.unknownReason;
  for (const child of trace.children ?? []) {
    const reason = firstUnknownReason(child);
    if (reason) return reason;
  }
  return null;
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

/** An age in words, so a skip reason reads like a sentence. */
function formatAge(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 90) return `${String(minutes)} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${String(hours)} hours`;
  return `${String(Math.round(hours / 24))} days`;
}
