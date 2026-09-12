import type { PrismaClient } from '@prisma/client';
import { ExecutionMode, StrategyStage, TradingEnvironment, dec } from '@zusu/shared';
import { AppError } from '../../lib/errors.js';
import type { BrokerRegistry } from '../broker/broker-registry.js';
import { strategyDefinitionSchema } from '../strategies/strategy.service.js';

/**
 * Live readiness (§Phase 9).
 *
 * The roadmap states eight conditions under which a strategy may go live. This
 * module is those eight conditions, checked independently, each answering with
 * its own evidence rather than with a shared boolean.
 *
 * Two rules govern the whole file:
 *
 *   1. **Unverifiable is not permission.** A check that cannot be run — no
 *      paper criteria configured, no reconciliation ever executed, a broker
 *      that will not answer — reports `UNVERIFIABLE` and blocks. The one place
 *      "we could not check" quietly becomes "it is fine" is a readiness gate,
 *      and that is the failure this design exists to prevent.
 *   2. **Every answer carries its numbers.** "Not ready" is useless; "the paper
 *      test has 4 trades against a required 20" tells someone what to do next.
 */

export type CheckState = 'PASS' | 'FAIL' | 'UNVERIFIABLE';

export interface ReadinessCheck {
  /** Stable identifier, so the UI can order and the tests can name them. */
  key:
    | 'BACKTEST_COMPLETE'
    | 'PAPER_TEST_PASSED'
    | 'RISK_LIMITS_CONFIGURED'
    | 'POSITION_SIZING_CONFIGURED'
    | 'STOP_LOSS_SET'
    | 'KILL_SWITCH_AVAILABLE'
    | 'BROKER_CONNECTION_VERIFIED'
    | 'RECONCILIATION_HEALTHY';
  label: string;
  state: CheckState;
  /** What was measured, and against what. Never a bare verdict. */
  detail: string;
}

export interface ReadinessReport {
  configId: string;
  portfolioId: string;
  strategyId: string;
  strategyVersionId: string;
  environment: TradingEnvironment;
  currentMode: ExecutionMode;
  checks: ReadinessCheck[];
  /** True only when every check passed. One UNVERIFIABLE is enough to block. */
  ready: boolean;
  /** The rung this config could be promoted to next, or null. */
  nextMode: ExecutionMode | null;
  summary: string;
}

/** The evidence thresholds. Deliberately explicit rather than tunable per call. */
export const READINESS_THRESHOLDS = {
  /** A backtest of fewer trades measures the sample, not the strategy. */
  minBacktestTrades: 20,
  /** Paper trades, closed, before anything is inferred from them. */
  minPaperTrades: 10,
  /** Calendar days a paper test must have run, so it spans more than one day's regime. */
  minPaperDays: 5,
  /** How stale a reconciliation may be before it stops counting as evidence. */
  reconciliationMaxAgeHours: 24,
} as const;

interface ConfigRow {
  id: string;
  portfolioId: string;
  strategyId: string;
  strategyVersionId: string;
  executionMode: string;
  positionSizing: unknown;
}

export class LiveReadinessService {
  constructor(
    private readonly db: PrismaClient,
    private readonly brokers: BrokerRegistry,
  ) {}

  async report(configId: string): Promise<ReadinessReport> {
    const config = await this.db.strategyPortfolioConfig.findUnique({
      where: { id: configId },
      include: { strategyVersion: true, portfolio: true },
    });
    if (!config) throw new AppError('NOT_FOUND', 'Strategy configuration not found');

    const checks = await Promise.all([
      this.backtestComplete(config),
      this.paperTestPassed(config),
      this.riskLimitsConfigured(config.portfolioId),
      this.positionSizingConfigured(config),
      this.stopLossSet(config.strategyVersion.definition),
      this.killSwitchAvailable(config.portfolioId),
      this.brokerConnectionVerified(config.portfolioId),
      this.reconciliationHealthy(config.portfolioId),
    ]);

    const ready = checks.every((check) => check.state === 'PASS');
    const blocking = checks.filter((check) => check.state !== 'PASS');
    const currentMode = config.executionMode as ExecutionMode;

    return {
      configId: config.id,
      portfolioId: config.portfolioId,
      strategyId: config.strategyId,
      strategyVersionId: config.strategyVersionId,
      environment: config.portfolio.environment as TradingEnvironment,
      currentMode,
      checks,
      ready,
      nextMode: nextRung(currentMode),
      summary: ready
        ? 'All eight conditions are met. The last one is a person, and it is not automated.'
        : `${String(blocking.length)} of 8 conditions are not met: ` +
          blocking.map((check) => check.label).join(', ') +
          '.',
    };
  }

  /**
   * 1. A backtest is complete.
   *
   * The *stage* label says a version passed through BACKTEST. This checks for
   * the artefact: a finished run with enough trades to mean anything. A stage
   * is a claim; a stored result is evidence.
   */
  private async backtestComplete(config: ConfigRow): Promise<ReadinessCheck> {
    const backtest = await this.db.backtest.findFirst({
      where: { strategyVersionId: config.strategyVersionId, status: 'COMPLETED' },
      orderBy: { createdAt: 'desc' },
      select: { id: true, createdAt: true, _count: { select: { trades: true } } },
    });

    if (!backtest) {
      return check(
        'BACKTEST_COMPLETE',
        'Backtest complete',
        'FAIL',
        'No completed backtest exists for this version. The stage label is not the evidence; ' +
          'the stored result is.',
      );
    }
    const trades = backtest._count.trades;
    if (trades < READINESS_THRESHOLDS.minBacktestTrades) {
      return check(
        'BACKTEST_COMPLETE',
        'Backtest complete',
        'FAIL',
        `The backtest produced ${String(trades)} trades against a required ` +
          `${String(READINESS_THRESHOLDS.minBacktestTrades)}. Below that the result measures ` +
          'the sample, not the strategy.',
      );
    }
    return check(
      'BACKTEST_COMPLETE',
      'Backtest complete',
      'PASS',
      `${String(trades)} trades, run ${backtest.createdAt.toISOString().slice(0, 10)}.`,
    );
  }

  /**
   * 2. A paper test meets its configured criteria.
   *
   * Measured on this strategy's own filled paper orders, because a Position
   * carries no strategy id — several strategies may hold the same symbol, and
   * splitting a shared position between them would be a guess presented as a
   * measurement. Cash attribution is exact instead: what the strategy's buys
   * cost, what its sells brought in, minus its fees.
   *
   * The one thing this convention does not see is a position the strategy
   * opened and a person closed by hand. That trade is not counted, which
   * understates rather than flatters the result — the safe direction for a
   * gate to be wrong in.
   */
  private async paperTestPassed(config: ConfigRow): Promise<ReadinessCheck> {
    const orders = await this.db.order.findMany({
      where: {
        strategyId: config.strategyId,
        environment: 'PAPER',
        status: 'FILLED',
      },
      select: {
        side: true,
        filledQty: true,
        averageFillPrice: true,
        feesTotal: true,
        filledAt: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'asc' },
    });

    if (orders.length === 0) {
      return check(
        'PAPER_TEST_PASSED',
        'Paper test passed',
        'UNVERIFIABLE',
        'This strategy has never filled an order in a paper portfolio, so there is no paper ' +
          'test to read. Unverifiable is not permission.',
      );
    }

    // A round trip needs both halves; closed trades are counted by exits.
    const exits = orders.filter((order) => order.side === 'SELL').length;
    if (exits < READINESS_THRESHOLDS.minPaperTrades) {
      return check(
        'PAPER_TEST_PASSED',
        'Paper test passed',
        'FAIL',
        `${String(exits)} closed paper trades against a required ` +
          `${String(READINESS_THRESHOLDS.minPaperTrades)}.`,
      );
    }

    const first = orders[0]?.createdAt;
    const last = orders[orders.length - 1]?.createdAt;
    const days = first && last ? Math.round((last.getTime() - first.getTime()) / 86_400_000) : 0;
    if (days < READINESS_THRESHOLDS.minPaperDays) {
      return check(
        'PAPER_TEST_PASSED',
        'Paper test passed',
        'FAIL',
        `The paper trades span ${String(days)} days against a required ` +
          `${String(READINESS_THRESHOLDS.minPaperDays)}. One day is one regime, not a test.`,
      );
    }

    let net = dec(0);
    for (const order of orders) {
      const price = order.averageFillPrice;
      if (!price) {
        return check(
          'PAPER_TEST_PASSED',
          'Paper test passed',
          'UNVERIFIABLE',
          'A filled paper order has no average fill price recorded, so the paper result cannot ' +
            'be totalled. A partial sum reported as the total would be worse than no answer.',
        );
      }
      const gross = dec(order.filledQty.toString()).times(dec(price.toString()));
      net = order.side === 'SELL' ? net.plus(gross) : net.minus(gross);
      net = net.minus(dec(order.feesTotal.toString()));
    }

    if (net.lessThanOrEqualTo(0)) {
      return check(
        'PAPER_TEST_PASSED',
        'Paper test passed',
        'FAIL',
        `${String(exits)} paper round trips over ${String(days)} days netted ${net.toFixed(2)} ` +
          'after costs. A paper test that did not make money is not a reason to risk any.',
      );
    }

    return check(
      'PAPER_TEST_PASSED',
      'Paper test passed',
      'PASS',
      `${String(exits)} closed paper trades over ${String(days)} days, net ${net.toFixed(2)} after costs.`,
    );
  }

  /** 3. Risk limits are configured and active for the portfolio. */
  private async riskLimitsConfigured(portfolioId: string): Promise<ReadinessCheck> {
    const limits = await this.db.riskLimit.findFirst({
      where: { portfolioId, isActive: true },
      orderBy: { version: 'desc' },
    });
    if (!limits) {
      return check(
        'RISK_LIMITS_CONFIGURED',
        'Risk limits configured',
        'FAIL',
        'This portfolio has no active risk limits. The risk engine blocks without them, so ' +
          'automation would produce nothing but refusals.',
      );
    }
    return check(
      'RISK_LIMITS_CONFIGURED',
      'Risk limits configured',
      'PASS',
      `Version ${String(limits.version)}: max daily loss ${limits.maxDailyLoss.toString()}, ` +
        `max position ${limits.maxPositionSize.toString()}.`,
    );
  }

  /** 4. Position sizing is configured on this strategy/portfolio pairing. */
  private positionSizingConfigured(config: ConfigRow): Promise<ReadinessCheck> {
    const sizing = config.positionSizing;
    const configured =
      sizing !== null &&
      typeof sizing === 'object' &&
      Object.keys(sizing as Record<string, unknown>).length > 0;

    return Promise.resolve(
      configured
        ? check(
            'POSITION_SIZING_CONFIGURED',
            'Position sizing configured',
            'PASS',
            `Sizing recorded: ${JSON.stringify(sizing)}.`,
          )
        : check(
            'POSITION_SIZING_CONFIGURED',
            'Position sizing configured',
            'FAIL',
            'No sizing is recorded for this pairing, so every order would fall back to a ' +
              'default nobody chose.',
          ),
    );
  }

  /** 5. A stop loss is set in the definition. */
  private stopLossSet(definition: unknown): Promise<ReadinessCheck> {
    const parsed = strategyDefinitionSchema.safeParse(definition);
    if (!parsed.success) {
      return Promise.resolve(
        check(
          'STOP_LOSS_SET',
          'Stop loss set',
          'UNVERIFIABLE',
          'This version is written in a rule language this build cannot read, so whether it ' +
            'has a stop cannot be determined — which is itself a reason not to run it.',
        ),
      );
    }
    return Promise.resolve(
      parsed.data.stop
        ? check(
            'STOP_LOSS_SET',
            'Stop loss set',
            'PASS',
            `Stop: ${parsed.data.stop.kind} at ${String(parsed.data.stop.value)}.`,
          )
        : check(
            'STOP_LOSS_SET',
            'Stop loss set',
            'FAIL',
            'This version has no stop. Trading without one is a bet, not a strategy.',
          ),
    );
  }

  /**
   * 6. The kill switch is available.
   *
   * Available means a halt would actually take effect: there is a trading-state
   * record to move, and the portfolio is not already halted for another reason.
   */
  private async killSwitchAvailable(portfolioId: string): Promise<ReadinessCheck> {
    const portfolio = await this.db.portfolio.findUnique({
      where: { id: portfolioId },
      select: { tradingState: true, haltedReason: true },
    });
    if (!portfolio) {
      return check(
        'KILL_SWITCH_AVAILABLE',
        'Kill switch available',
        'UNVERIFIABLE',
        'The portfolio could not be loaded, so the state the switch acts on is unknown.',
      );
    }
    if (portfolio.tradingState !== 'ACTIVE') {
      return check(
        'KILL_SWITCH_AVAILABLE',
        'Kill switch available',
        'FAIL',
        `Trading is already ${portfolio.tradingState.toLowerCase()} for this portfolio` +
          `${portfolio.haltedReason ? ` (${portfolio.haltedReason})` : ''}. Automation cannot ` +
          'be raised while the brake is on.',
      );
    }
    return check(
      'KILL_SWITCH_AVAILABLE',
      'Kill switch available',
      'PASS',
      'The portfolio is ACTIVE, so a halt has somewhere to move it to and would take effect.',
    );
  }

  /** 7. The broker connection is verified — by asking it, not by assuming it. */
  private async brokerConnectionVerified(portfolioId: string): Promise<ReadinessCheck> {
    const portfolio = await this.db.portfolio.findUnique({ where: { id: portfolioId } });
    if (!portfolio) {
      return check(
        'BROKER_CONNECTION_VERIFIED',
        'Broker connection verified',
        'UNVERIFIABLE',
        'The portfolio could not be loaded.',
      );
    }

    try {
      const health = await this.brokers.forPortfolio(portfolio).healthCheck();
      return health.ok
        ? check(
            'BROKER_CONNECTION_VERIFIED',
            'Broker connection verified',
            'PASS',
            health.detail ?? `Reachable in ${String(health.latencyMs ?? 0)}ms.`,
          )
        : check(
            'BROKER_CONNECTION_VERIFIED',
            'Broker connection verified',
            'FAIL',
            health.detail ?? 'The broker reported itself unhealthy.',
          );
    } catch (error) {
      return check(
        'BROKER_CONNECTION_VERIFIED',
        'Broker connection verified',
        'UNVERIFIABLE',
        `The broker could not be reached: ${error instanceof Error ? error.message : 'unknown error'}.`,
      );
    }
  }

  /**
   * 8. Reconciliation is healthy.
   *
   * Healthy means a recent run found no difference. Never having run is
   * UNVERIFIABLE, not healthy — "we have never checked" and "we checked and it
   * matched" are the two answers this gate most needs to keep apart.
   */
  private async reconciliationHealthy(portfolioId: string): Promise<ReadinessCheck> {
    const account = await this.db.brokerAccount.findFirst({ where: { portfolioId } });
    if (!account) {
      return check(
        'RECONCILIATION_HEALTHY',
        'Reconciliation healthy',
        'UNVERIFIABLE',
        'No broker account is linked, so no reconciliation has ever been stored for this ' +
          'portfolio. Never having checked is not the same as having matched.',
      );
    }

    const latest = await this.db.reconciliation.findFirst({
      where: { brokerAccountId: account.id },
      orderBy: { startedAt: 'desc' },
    });
    if (!latest) {
      return check(
        'RECONCILIATION_HEALTHY',
        'Reconciliation healthy',
        'UNVERIFIABLE',
        'Reconciliation has never run for this portfolio.',
      );
    }

    const ageHours = (Date.now() - latest.startedAt.getTime()) / 3_600_000;
    if (ageHours > READINESS_THRESHOLDS.reconciliationMaxAgeHours) {
      return check(
        'RECONCILIATION_HEALTHY',
        'Reconciliation healthy',
        'UNVERIFIABLE',
        `The last reconciliation ran ${ageHours.toFixed(0)} hours ago, past the ` +
          `${String(READINESS_THRESHOLDS.reconciliationMaxAgeHours)}-hour window. Stale agreement ` +
          'is not current agreement.',
      );
    }
    if (!latest.succeeded) {
      return check(
        'RECONCILIATION_HEALTHY',
        'Reconciliation healthy',
        'FAIL',
        latest.detail ??
          'The last reconciliation found differences, and nothing has resolved them.',
      );
    }
    return check(
      'RECONCILIATION_HEALTHY',
      'Reconciliation healthy',
      'PASS',
      `Matched ${ageHours.toFixed(1)} hours ago.`,
    );
  }
}

function check(
  key: ReadinessCheck['key'],
  label: string,
  state: CheckState,
  detail: string,
): ReadinessCheck {
  return { key, label, state, detail };
}

/** The next rung up, or null at the top. */
export function nextRung(mode: ExecutionMode): ExecutionMode | null {
  switch (mode) {
    case ExecutionMode.OBSERVE:
      return ExecutionMode.MANUAL_APPROVAL;
    case ExecutionMode.MANUAL_APPROVAL:
      return ExecutionMode.LIMITED_AUTO;
    case ExecutionMode.LIMITED_AUTO:
      return ExecutionMode.FULL_AUTO;
    default:
      return null;
  }
}

/** Exported so the strategy ladder and the automation ladder agree on the term. */
export const LIVE_STAGE = StrategyStage.LIVE;
