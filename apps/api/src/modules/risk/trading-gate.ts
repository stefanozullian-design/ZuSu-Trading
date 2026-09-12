import type { Portfolio, PrismaClient } from '@prisma/client';
import {
  ExecutionMode,
  MarketSession,
  ServiceStatus,
  TradingEnvironment,
  TradingState,
} from '@zusu/shared';
import { config } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';
import type { BrokerRegistry } from '../broker/broker-registry.js';
import type { HealthService } from '../health/health.service.js';
import type { MarketCalendarService } from '../market-data/calendar.service.js';
import type { MarketDataQualityService } from '../market-data/quality.service.js';

export type BlockerSeverity = 'BLOCKING' | 'WARNING';

export interface GateBlocker {
  code: string;
  message: string;
  severity: BlockerSeverity;
}

export interface GateDecision {
  portfolioId: string;
  allowed: boolean;
  blockers: GateBlocker[];
  checkedAt: string;
}

/**
 * The deterministic gate every order must pass before it may reach a broker.
 *
 * Phase 1 has no order-submission path, so today the gate is evaluated for
 * display (the dashboard's risk monitor) and by the kill-switch tests. From
 * Phase 8 the order manager calls `assertCanTrade` on exactly the same object,
 * which is why the checks live here rather than in a route handler.
 *
 * Portfolio-level limits (daily loss, exposure, correlation, …) are the risk
 * engine's job in Phase 7 and are deliberately not faked here.
 */
export class TradingGate {
  constructor(
    private readonly db: PrismaClient,
    private readonly registry: BrokerRegistry,
    private readonly health: HealthService,
    private readonly quality: MarketDataQualityService,
    private readonly calendar: MarketCalendarService,
  ) {}

  /**
   * @param options.symbol The symbol an order is for, when there is one. Two
   *   checks need it: per-symbol data-quality faults (without it only feed-wide
   *   faults block, because one impossible symbol should not halt a whole
   *   portfolio), and whether that symbol is tradable at all at `at` — market
   *   closed, holiday, halted, or not tradable on this platform.
   * @param options.at The instant to judge. Injectable so a gate decision is
   *   reproducible: a check that read the wall clock would give a different
   *   answer depending on when it ran, which is untestable and unauditable.
   */
  async evaluate(
    portfolio: Portfolio,
    options: { symbol?: string; at?: Date } = {},
  ): Promise<GateDecision> {
    const blockers: GateBlocker[] = [];
    const environment = portfolio.environment as TradingEnvironment;
    const symbol = options.symbol;
    const at = options.at ?? new Date();

    if (!portfolio.isActive) {
      blockers.push({
        code: 'PORTFOLIO_INACTIVE',
        message: 'This portfolio is deactivated.',
        severity: 'BLOCKING',
      });
    }

    if (portfolio.tradingState === TradingState.HALTED) {
      blockers.push({
        code: 'TRADING_HALTED',
        message: portfolio.haltedReason
          ? `Trading is halted: ${portfolio.haltedReason}`
          : 'Trading is halted by the kill switch.',
        severity: 'BLOCKING',
      });
    }

    if (portfolio.tradingState === TradingState.RECONCILIATION_ERROR) {
      blockers.push({
        code: 'RECONCILIATION_ERROR',
        message:
          'Internal records and the broker disagree. Trading stays blocked until the difference is resolved.',
        severity: 'BLOCKING',
      });
    }

    if (portfolio.executionMode === ExecutionMode.OBSERVE) {
      blockers.push({
        code: 'OBSERVE_ONLY',
        message: 'This portfolio is in observe-only mode; signals are recorded but never sent.',
        severity: 'BLOCKING',
      });
    }

    if (environment === TradingEnvironment.LIVE && !config().ALLOW_LIVE_TRADING) {
      blockers.push({
        code: 'LIVE_TRADING_DISABLED',
        message: 'Live trading is disabled on this deployment (ALLOW_LIVE_TRADING is false).',
        severity: 'BLOCKING',
      });
    }

    if (!this.registry.isSupported(environment)) {
      blockers.push({
        code: 'BROKER_NOT_AVAILABLE',
        message: `No broker adapter is available for ${environment} portfolios yet.`,
        severity: 'BLOCKING',
      });
    }

    const health = await this.health.snapshot();
    for (const service of health.services) {
      if (service.status === ServiceStatus.DOWN) {
        blockers.push({
          code: `SERVICE_DOWN_${service.service}`,
          message: `${service.service} is unavailable: ${service.detail ?? 'no detail'}.`,
          severity: isTradingCritical(service.service) ? 'BLOCKING' : 'WARNING',
        });
      } else if (service.status === ServiceStatus.DEGRADED) {
        blockers.push({
          code: `SERVICE_DEGRADED_${service.service}`,
          message: `${service.service} is degraded: ${service.detail ?? 'no detail'}.`,
          severity: 'WARNING',
        });
      }
    }

    // Market-data quality (§6). A feed the platform knows to be wrong is not a
    // degraded convenience; it is a reason not to trade. Demo portfolios are
    // exempt because they are priced by the simulator, not by the provider.
    if (environment !== TradingEnvironment.DEMO) {
      const verdict = await this.quality.verdict();
      for (const event of verdict.feedWide) {
        blockers.push({
          code: `MARKET_DATA_${event.issue}`,
          message: `Market data is unusable: ${event.detail}`,
          severity: 'BLOCKING',
        });
      }
      if (symbol) {
        for (const event of verdict.bySymbol.filter((e) => e.symbol === symbol)) {
          blockers.push({
            code: `MARKET_DATA_${event.issue}`,
            message: `Market data for ${symbol} is unusable: ${event.detail}`,
            severity: 'BLOCKING',
          });
        }
      } else if (verdict.bySymbol.length > 0) {
        blockers.push({
          code: 'MARKET_DATA_SYMBOL_ISSUES',
          message:
            `${verdict.bySymbol.length} symbol(s) have unusable market data. ` +
            'Orders in those symbols will be refused.',
          severity: 'WARNING',
        });
      }
    }

    // Tradability of the specific symbol (§7): market closed, holiday, halt, or
    // an instrument that is not tradable at all. Only checkable when the order
    // names a symbol, and DEMO is priced by the simulator, which has its own
    // session logic.
    if (symbol && environment !== TradingEnvironment.DEMO) {
      const verdict = await this.calendar.isTradable(symbol, at);
      if (!verdict.tradable) {
        blockers.push({
          code: verdict.session === MarketSession.HALTED ? 'SYMBOL_HALTED' : 'MARKET_CLOSED',
          message: verdict.reason ?? `${symbol} cannot be traded right now.`,
          severity: 'BLOCKING',
        });
      }
    }

    return {
      portfolioId: portfolio.id,
      allowed: !blockers.some((b) => b.severity === 'BLOCKING'),
      blockers,
      checkedAt: new Date().toISOString(),
    };
  }

  /** Throws with the first blocking reason. Never silently permits (§84 Rule 4). */
  async assertCanTrade(
    portfolioId: string,
    options: { symbol?: string; at?: Date } = {},
  ): Promise<GateDecision> {
    const portfolio = await this.db.portfolio.findUnique({ where: { id: portfolioId } });
    if (!portfolio) throw new AppError('NOT_FOUND', 'Portfolio not found');

    const decision = await this.evaluate(portfolio, options);
    if (!decision.allowed) {
      const blocking = decision.blockers.find((b) => b.severity === 'BLOCKING');
      throw new AppError(
        blocking?.code === 'TRADING_HALTED' ? 'TRADING_HALTED' : 'RISK_REJECTED',
        blocking?.message ?? 'Trading is not permitted for this portfolio.',
        { details: decision.blockers },
      );
    }
    return decision;
  }
}

/** Services whose absence must stop new trades outright (§55). */
function isTradingCritical(service: string): boolean {
  return service === 'DATABASE' || service === 'BROKER' || service === 'MARKET_DATA';
}
