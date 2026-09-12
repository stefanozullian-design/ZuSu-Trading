import type { PrismaClient, Prisma } from '@prisma/client';
import {
  AuditAction,
  ExecutionMode,
  Permission,
  TradingEnvironment,
  assertExecutionModeTransition,
  dec,
  isAutomatic,
} from '@zusu/shared';
import { config as appConfig } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';
import type { AuditService } from '../audit/audit.service.js';
import type { AccessControl, Principal } from '../rbac/access-control.js';
import type { OrderService } from '../orders/order.service.js';
import type { LiveReadinessService, ReadinessReport } from './live-readiness.js';

/**
 * The automation ladder (Phase 9).
 *
 * This is the module the whole platform has been deferring to. Everything
 * before it produces recommendations; this decides whether a recommendation may
 * become an order without someone clicking Approve — and the answer is a rung
 * on a ladder that only a person can climb.
 *
 * The design rules, in the order they matter:
 *
 *   1. **Climbing is a human act; descending is not.** Raising the mode needs
 *      the `strategy:promote` permission, an all-pass readiness report, and a
 *      typed confirmation naming the rung. Lowering it needs none of those and
 *      can never be refused — a brake that a state machine can decline to
 *      apply is not a brake.
 *   2. **Full automation is never reached automatically.** Nothing in this file
 *      or the scheduler raises a mode. `promote` is reachable only from a route
 *      behind a session, and one rung at a time, so FULL_AUTO is at minimum two
 *      deliberate human decisions after MANUAL_APPROVAL.
 *   3. **Readiness is re-checked at execution time, not only at promotion.**
 *      A strategy promoted on Monday against a healthy broker is not entitled
 *      to trade on Friday against a broken one. Every automatic order revisits
 *      all eight conditions first.
 *   4. **Automation is attributed to the person who authorised it.** The
 *      promoter's identity is stored and orders are placed as them, audited
 *      with actor type SCHEDULER. If that account is deactivated or loses the
 *      permission, automation stops — an automated system acting under nobody's
 *      authority is exactly what this platform is built to not be.
 */

/** LIMITED_AUTO's caps. The rung exists to be watched, so the caps are small. */
export const LIMITED_AUTO_DEFAULTS = {
  maxOrdersPerDay: 3,
  maxNotionalPerOrder: '2500',
} as const;

/** What a promoter must type, with the rung's own name in it. */
export function confirmationPhraseFor(mode: ExecutionMode): string {
  return `I authorise ${mode}`;
}

interface AutomationOverrides {
  promotedById?: string;
  promotedAt?: string;
  limitedAuto?: { maxOrdersPerDay?: number; maxNotionalPerOrder?: string };
}

export interface ModeChange {
  configId: string;
  from: ExecutionMode;
  to: ExecutionMode;
  detail: string;
}

export interface AutomaticRun {
  configId: string;
  portfolioId: string;
  mode: ExecutionMode;
  placed: string[];
  /** Signals left for a person, each with the reason automation would not take it. */
  deferred: { signalId: string; reason: string }[];
}

export class AutomationService {
  constructor(
    private readonly db: PrismaClient,
    private readonly access: AccessControl,
    private readonly audit: AuditService,
    private readonly readiness: LiveReadinessService,
    private readonly orders: OrderService,
  ) {}

  /**
   * Moves one configuration along the automation ladder.
   *
   * Raising is gated four ways; lowering is gated none.
   */
  async promote(
    principal: Principal,
    configId: string,
    to: ExecutionMode,
    input: { confirmation?: string; reason?: string } = {},
  ): Promise<ModeChange> {
    const config = await this.db.strategyPortfolioConfig.findUnique({
      where: { id: configId },
      include: { portfolio: true },
    });
    if (!config) throw new AppError('NOT_FOUND', 'Strategy configuration not found');

    await this.access.assertPortfolioAccess(principal, config.portfolioId, {
      permission: Permission.STRATEGY_PROMOTE,
      requireTrade: true,
    });

    const from = config.executionMode as ExecutionMode;
    if (from === to) {
      throw new AppError('CONFLICT', `This configuration is already at ${to}.`);
    }

    try {
      assertExecutionModeTransition(from, to);
    } catch {
      throw new AppError(
        'CONFLICT',
        `${from} cannot move to ${to}. Automation is raised one rung at a time — ` +
          'LIMITED_AUTO exists precisely to be the period someone watches it trade under caps, ' +
          'and skipping it would skip the only evidence that the live version works.',
      );
    }

    const raising = isRaise(from, to);

    if (raising) {
      const expected = confirmationPhraseFor(to);
      if (input.confirmation?.trim() !== expected) {
        throw new AppError(
          'VALIDATION_FAILED',
          `Raising automation to ${to} requires typing "${expected}" exactly. ` +
            'A confirmation that can be produced by a stray click is not a confirmation.',
        );
      }

      if (
        isAutomatic(to) &&
        config.portfolio.environment === TradingEnvironment.LIVE &&
        !appConfig().ALLOW_LIVE_TRADING
      ) {
        throw new AppError(
          'FORBIDDEN',
          'This portfolio is LIVE and ALLOW_LIVE_TRADING is false on this deployment. ' +
            'Automation on real money needs the deployment-wide switch first, which is a ' +
            'deliberate act outside this application.',
        );
      }

      const report = await this.readiness.report(configId);
      if (!report.ready) {
        throw new AppError(
          'RISK_REJECTED',
          `${report.summary} Each is listed with what it measured; none of them is waived here.`,
        );
      }
    }

    const overrides = readOverrides(config.overrides);
    const nextOverrides: AutomationOverrides = raising
      ? { ...overrides, promotedById: principal.id, promotedAt: new Date().toISOString() }
      : // Lowering clears the authority: whoever raises it next signs for it again.
        { ...overrides, promotedById: undefined, promotedAt: undefined };

    await this.db.strategyPortfolioConfig.update({
      where: { id: configId },
      data: {
        executionMode: to,
        overrides: nextOverrides as unknown as Prisma.InputJsonValue,
      },
    });

    await this.audit.record({
      action: raising ? AuditAction.STRATEGY_PROMOTED : AuditAction.STRATEGY_DEMOTED,
      actorUserId: principal.id,
      actorType: 'USER',
      entityType: 'strategy_portfolio_config',
      entityId: configId,
      portfolioId: config.portfolioId,
      environment: config.portfolio.environment as TradingEnvironment,
      before: { executionMode: from },
      after: { executionMode: to },
      ...(input.reason ? { metadata: { reason: input.reason } } : {}),
    });

    return {
      configId,
      from,
      to,
      detail: raising
        ? `Raised from ${from} to ${to}, authorised by ${principal.email}. Every automatic ` +
          'order re-checks all eight conditions before it is placed.'
        : `Lowered from ${from} to ${to}. Lowering is never refused, and it clears the ` +
          'authority: raising it again is a fresh signature.',
    };
  }

  async readinessFor(principal: Principal, configId: string): Promise<ReadinessReport> {
    const config = await this.db.strategyPortfolioConfig.findUnique({ where: { id: configId } });
    if (!config) throw new AppError('NOT_FOUND', 'Strategy configuration not found');
    await this.access.assertPortfolioAccess(principal, config.portfolioId, {
      permission: Permission.STRATEGY_READ,
    });
    return this.readiness.report(configId);
  }

  /** Every configuration this principal may see, with its rung. */
  async list(principal: Principal): Promise<
    {
      configId: string;
      strategyName: string;
      version: number;
      portfolioId: string;
      portfolioName: string;
      environment: TradingEnvironment;
      isEnabled: boolean;
      mode: ExecutionMode;
      promotedById: string | null;
    }[]
  > {
    const portfolioIds = await this.access.listAccessiblePortfolioIds(principal);
    const rows = await this.db.strategyPortfolioConfig.findMany({
      where: { portfolioId: { in: portfolioIds } },
      include: { strategy: true, strategyVersion: true, portfolio: true },
      orderBy: { createdAt: 'asc' },
    });

    return rows.map((row) => ({
      configId: row.id,
      strategyName: row.strategy.name,
      version: row.strategyVersion.version,
      portfolioId: row.portfolioId,
      portfolioName: row.portfolio.name,
      environment: row.portfolio.environment as TradingEnvironment,
      isEnabled: row.isEnabled,
      mode: row.executionMode as ExecutionMode,
      promotedById: readOverrides(row.overrides).promotedById ?? null,
    }));
  }

  /**
   * Places orders for configurations that a person has put on an automatic
   * rung. Called by the scheduler; it can raise nothing and enable nothing.
   */
  async runAutomatic(at: Date = new Date()): Promise<AutomaticRun[]> {
    const configs = await this.db.strategyPortfolioConfig.findMany({
      where: {
        isEnabled: true,
        executionMode: { in: [ExecutionMode.LIMITED_AUTO, ExecutionMode.FULL_AUTO] },
      },
      include: { portfolio: true },
    });

    const runs: AutomaticRun[] = [];
    for (const config of configs) {
      runs.push(await this.runOne(config.id, config.portfolioId, at));
    }
    return runs;
  }

  private async runOne(configId: string, portfolioId: string, at: Date): Promise<AutomaticRun> {
    const config = await this.db.strategyPortfolioConfig.findUniqueOrThrow({
      where: { id: configId },
      include: { portfolio: true },
    });
    const mode = config.executionMode as ExecutionMode;
    const run: AutomaticRun = { configId, portfolioId, mode, placed: [], deferred: [] };

    const waiting = await this.db.signal.findMany({
      where: {
        portfolioId,
        strategyId: config.strategyId,
        status: { in: ['CREATED', 'PENDING_APPROVAL'] },
      },
      orderBy: { createdAt: 'asc' },
    });
    if (waiting.length === 0) return run;

    const defer = (reason: string): AutomaticRun => {
      run.deferred = waiting
        .map((signal) => ({ signal, reason }))
        .map(({ signal, reason: r }) => ({
          signalId: signal.id,
          reason: r,
        }));
      return run;
    };

    // The authority. Automation acting under nobody's name is the thing this
    // platform exists to not be.
    const overrides = readOverrides(config.overrides);
    if (!overrides.promotedById) {
      return defer(
        'This configuration is on an automatic rung with no recorded authority. Nothing is ' +
          'placed under nobody’s name; lower it and raise it again.',
      );
    }
    const promoter = await this.db.user.findUnique({ where: { id: overrides.promotedById } });
    if (!promoter?.isActive) {
      return defer(
        'The person who authorised this automation is no longer an active user, so their ' +
          'authority no longer stands. These recommendations wait for a person.',
      );
    }
    const principal: Principal = {
      id: promoter.id,
      role: promoter.role,
      clientId: promoter.clientId,
      email: promoter.email,
      isActive: promoter.isActive,
    };

    if (
      isAutomatic(mode) &&
      config.portfolio.environment === TradingEnvironment.LIVE &&
      !appConfig().ALLOW_LIVE_TRADING
    ) {
      return defer(
        'This portfolio is LIVE and ALLOW_LIVE_TRADING is false, so nothing automatic runs ' +
          'against it however it was promoted.',
      );
    }

    // Rule 3: readiness is a condition of every order, not of the promotion.
    const report = await this.readiness.report(configId);
    if (!report.ready) {
      return defer(
        `Automation is paused for this configuration: ${report.summary} ` +
          'The recommendations stand and wait for a person.',
      );
    }

    const caps = capsFor(mode, overrides);
    let placedToday = caps ? await this.autoOrdersToday(portfolioId, config.strategyId, at) : 0;

    for (const signal of waiting) {
      if (caps && placedToday >= caps.maxOrdersPerDay) {
        run.deferred.push({
          signalId: signal.id,
          reason:
            `LIMITED_AUTO has already placed ${String(placedToday)} orders today, its cap. ` +
            'The rest wait for a person rather than being placed under a raised cap nobody set.',
        });
        continue;
      }

      if (caps) {
        const notional = dec(signal.notional?.toString() ?? '0');
        if (notional.greaterThan(dec(caps.maxNotionalPerOrder))) {
          run.deferred.push({
            signalId: signal.id,
            reason:
              `${notional.toFixed(2)} exceeds the LIMITED_AUTO per-order cap of ` +
              `${caps.maxNotionalPerOrder}. A trade too big for the cap is exactly the one a ` +
              'person should look at.',
          });
          continue;
        }
      }

      try {
        const order = await this.orders.approveSignal(principal, signal.id, {
          at,
          automated: true,
          note: `Placed automatically at ${mode}, authorised by ${promoter.email}.`,
        });
        run.placed.push(order.id);
        placedToday += 1;
      } catch (error) {
        // A refusal is the system working. It is recorded against the signal,
        // which stays waiting rather than disappearing.
        run.deferred.push({
          signalId: signal.id,
          reason: error instanceof Error ? error.message : 'Unknown failure placing the order.',
        });
      }
    }

    return run;
  }

  private async autoOrdersToday(
    portfolioId: string,
    strategyId: string,
    at: Date,
  ): Promise<number> {
    const dayStart = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
    return this.db.order.count({
      where: { portfolioId, strategyId, createdAt: { gte: dayStart } },
    });
  }
}

function isRaise(from: ExecutionMode, to: ExecutionMode): boolean {
  const order = [
    ExecutionMode.OBSERVE,
    ExecutionMode.MANUAL_APPROVAL,
    ExecutionMode.LIMITED_AUTO,
    ExecutionMode.FULL_AUTO,
  ];
  return order.indexOf(to) > order.indexOf(from);
}

function readOverrides(value: unknown): AutomationOverrides {
  if (value === null || typeof value !== 'object') return {};
  return value as AutomationOverrides;
}

function capsFor(
  mode: ExecutionMode,
  overrides: AutomationOverrides,
): { maxOrdersPerDay: number; maxNotionalPerOrder: string } | null {
  if (mode !== ExecutionMode.LIMITED_AUTO) return null;
  return {
    maxOrdersPerDay:
      overrides.limitedAuto?.maxOrdersPerDay ?? LIMITED_AUTO_DEFAULTS.maxOrdersPerDay,
    maxNotionalPerOrder:
      overrides.limitedAuto?.maxNotionalPerOrder ?? LIMITED_AUTO_DEFAULTS.maxNotionalPerOrder,
  };
}
