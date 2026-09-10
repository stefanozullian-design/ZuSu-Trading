import type { PrismaClient } from '@prisma/client';
import {
  AuditAction,
  Permission,
  TradingEnvironment,
  TradingState,
  WsEvent,
  isTerminalOrderStatus,
} from '@zusu/shared';
import { randomUUID } from '../../lib/crypto.js';
import { AppError } from '../../lib/errors.js';
import type { AuditService } from '../audit/audit.service.js';
import type { BrokerRegistry } from '../broker/broker-registry.js';
import type { AccessControl, Principal } from '../rbac/access-control.js';

export interface KillSwitchResult {
  portfoliosHalted: string[];
  ordersCancelled: number;
  reason: string;
  engagedAt: string;
}

export interface EventPublisher {
  publish(
    event: WsEvent,
    portfolioId: string | null,
    payload: unknown,
    correlationId: string,
  ): void;
}

/**
 * The kill switch (§22).
 *
 * Engaging it moves a portfolio out of ACTIVE, which is a blocking condition in
 * `TradingGate`, and cancels resting entry orders at the broker. Existing
 * positions are deliberately left alone — halting trading must never
 * itself liquidate an account. Closing positions is a separate, explicitly
 * confirmed action (§23).
 */
export class KillSwitchService {
  constructor(
    private readonly db: PrismaClient,
    private readonly access: AccessControl,
    private readonly audit: AuditService,
    private readonly brokers: BrokerRegistry,
    private readonly events?: EventPublisher,
  ) {}

  async engage(
    principal: Principal,
    input: { reason: string; portfolioId?: string },
    context: { ip?: string | null; userAgent?: string | null } = {},
  ): Promise<KillSwitchResult> {
    this.access.assertPermission(principal, Permission.KILL_SWITCH_ACTIVATE);

    const targets = input.portfolioId
      ? [
          await this.access.assertPortfolioAccess(principal, input.portfolioId, {
            permission: Permission.KILL_SWITCH_ACTIVATE,
          }),
        ]
      : await this.db.portfolio.findMany({
          where: {
            AND: [this.access.portfolioScope(principal), { tradingState: TradingState.ACTIVE }],
          },
        });

    const engagedAt = new Date();
    const correlationId = randomUUID();
    const halted: string[] = [];
    let ordersCancelled = 0;

    for (const portfolio of targets) {
      if (portfolio.tradingState === TradingState.RECONCILIATION_ERROR) {
        // Already blocked for a stronger reason; do not weaken it.
        continue;
      }

      await this.db.$transaction(async (tx) => {
        await tx.portfolio.update({
          where: { id: portfolio.id },
          data: {
            tradingState: TradingState.HALTED,
            haltedReason: input.reason,
            haltedAt: engagedAt,
          },
        });
        await tx.riskEvent.create({
          data: {
            portfolioId: portfolio.id,
            type: 'KILL_SWITCH_MANUAL',
            severity: 'CRITICAL',
            message: input.reason,
            metadata: { engagedBy: principal.email },
          },
        });
        await this.audit.record(
          {
            action: AuditAction.KILL_SWITCH_ACTIVATED,
            actorUserId: principal.id,
            entityType: 'Portfolio',
            entityId: portfolio.id,
            portfolioId: portfolio.id,
            correlationId,
            environment: portfolio.environment as TradingEnvironment,
            before: { tradingState: portfolio.tradingState },
            after: { tradingState: TradingState.HALTED, reason: input.reason },
            ip: context.ip ?? null,
            userAgent: context.userAgent ?? null,
          },
          tx,
        );
      });

      ordersCancelled += await this.cancelRestingOrders(
        portfolio.id,
        portfolio.environment as TradingEnvironment,
      );
      halted.push(portfolio.id);
      this.events?.publish(
        WsEvent.RISK_HALTED,
        portfolio.id,
        { portfolioId: portfolio.id, reason: input.reason, engagedAt: engagedAt.toISOString() },
        correlationId,
      );
    }

    return {
      portfoliosHalted: halted,
      ordersCancelled,
      reason: input.reason,
      engagedAt: engagedAt.toISOString(),
    };
  }

  /** Releasing a halt is an administrator action — a manager can stop, not start. */
  async release(
    principal: Principal,
    portfolioId: string,
    reason: string,
    context: { ip?: string | null; userAgent?: string | null } = {},
  ): Promise<{ portfolioId: string; tradingState: TradingState }> {
    this.access.assertPermission(principal, Permission.KILL_SWITCH_RELEASE);
    const portfolio = await this.access.assertPortfolioAccess(principal, portfolioId, {
      permission: Permission.KILL_SWITCH_RELEASE,
    });

    if (portfolio.tradingState === TradingState.RECONCILIATION_ERROR) {
      throw new AppError(
        'CONFLICT',
        'This portfolio is blocked by a reconciliation mismatch, which must be resolved before trading resumes.',
      );
    }
    if (portfolio.tradingState === TradingState.ACTIVE) {
      return { portfolioId, tradingState: TradingState.ACTIVE };
    }

    await this.db.$transaction(async (tx) => {
      await tx.portfolio.update({
        where: { id: portfolioId },
        data: { tradingState: TradingState.ACTIVE, haltedReason: null, haltedAt: null },
      });
      await tx.riskEvent.updateMany({
        where: { portfolioId, type: 'KILL_SWITCH_MANUAL', resolvedAt: null },
        data: { resolvedAt: new Date() },
      });
      await this.audit.record(
        {
          action: AuditAction.KILL_SWITCH_RELEASED,
          actorUserId: principal.id,
          entityType: 'Portfolio',
          entityId: portfolioId,
          portfolioId,
          environment: portfolio.environment as TradingEnvironment,
          before: { tradingState: portfolio.tradingState, reason: portfolio.haltedReason },
          after: { tradingState: TradingState.ACTIVE, reason },
          metadata: { releaseReason: reason },
          ip: context.ip ?? null,
          userAgent: context.userAgent ?? null,
        },
        tx,
      );
    });

    return { portfolioId, tradingState: TradingState.ACTIVE };
  }

  /**
   * Cancels resting orders at the broker. Only environments with a working
   * adapter can be acted on; for the others the halt still stands and the
   * absence of an adapter means no order could have been placed anyway.
   */
  private async cancelRestingOrders(
    portfolioId: string,
    environment: TradingEnvironment,
  ): Promise<number> {
    if (!this.brokers.isSupported(environment)) return 0;
    const broker = this.brokers.demoBrokerFor(portfolioId);
    if (!broker) return 0;

    const open = await broker.getOrders({ openOnly: true });
    let cancelled = 0;
    for (const order of open) {
      const result = await broker.cancelOrder(order.brokerOrderId);
      if (isTerminalOrderStatus(result.status) && result.status === 'CANCELLED') cancelled += 1;
    }
    return cancelled;
  }
}
