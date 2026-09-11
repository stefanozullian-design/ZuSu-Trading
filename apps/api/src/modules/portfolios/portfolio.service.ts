import type { Portfolio, PrismaClient } from '@prisma/client';
import {
  AuditAction,
  Decimal,
  ExecutionMode,
  Permission,
  TradingEnvironment,
  TradingState,
  dec,
  percentChange,
  toMoneyString,
  type CreatePortfolioInput,
  type PortfolioSummary,
  type PositionDto,
} from '@zusu/shared';
import { config } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';
import type { AuditService } from '../audit/audit.service.js';
import type { BrokerRegistry } from '../broker/broker-registry.js';
import type { AccessControl, Principal } from '../rbac/access-control.js';

/** Conservative starting limits for a new portfolio (§20). Tunable by an admin. */
const DEFAULT_RISK_LIMITS = {
  maxDailyLossPctOfCapital: 0.02,
  maxWeeklyLossPctOfCapital: 0.05,
  maxPositionSizePctOfCapital: 0.1,
  maxPortfolioExposurePct: 60,
  maxSectorExposurePct: 30,
  maxSymbolExposurePct: 15,
  maxOpenPositions: 10,
  maxTradesPerDay: 20,
  maxConsecutiveLosses: 4,
  maxDrawdownPct: 15,
} as const;

export class PortfolioService {
  constructor(
    private readonly db: PrismaClient,
    private readonly access: AccessControl,
    private readonly audit: AuditService,
    private readonly brokers: BrokerRegistry,
  ) {}

  async list(principal: Principal): Promise<PortfolioSummary[]> {
    this.access.assertPermission(principal, Permission.PORTFOLIO_READ);
    const portfolios = await this.db.portfolio.findMany({
      where: this.access.portfolioScope(principal),
      orderBy: [{ environment: 'asc' }, { name: 'asc' }],
      include: { client: { select: { id: true, name: true } } },
    });
    return Promise.all(portfolios.map((p) => this.summarise(p, p.client)));
  }

  async get(principal: Principal, portfolioId: string): Promise<PortfolioSummary> {
    const portfolio = await this.access.assertPortfolioAccess(principal, portfolioId, {
      permission: Permission.PORTFOLIO_READ,
    });
    const client = portfolio.clientId
      ? await this.db.client.findUnique({
          where: { id: portfolio.clientId },
          select: { id: true, name: true },
        })
      : null;
    return this.summarise(portfolio, client);
  }

  async positions(principal: Principal, portfolioId: string): Promise<PositionDto[]> {
    const portfolio = await this.access.assertPortfolioAccess(principal, portfolioId, {
      permission: Permission.POSITION_READ,
    });
    const positions = await this.db.position.findMany({
      where: { portfolioId: portfolio.id, status: 'OPEN' },
      orderBy: { openedAt: 'desc' },
    });
    const marks = await this.markPrices(
      portfolio,
      positions.map((p) => p.symbol),
    );

    return positions.map((p) => {
      const mark = marks.get(p.symbol) ?? null;
      const marketValue = mark ? mark.times(p.quantity) : null;
      const unrealised = mark
        ? mark.minus(dec(p.averageEntryPrice.toString())).times(p.quantity)
        : null;
      return {
        id: p.id,
        portfolioId: p.portfolioId,
        symbol: p.symbol,
        assetClass: p.assetClass,
        quantity: p.quantity.toString(),
        averageEntryPrice: p.averageEntryPrice.toString(),
        markPrice: mark ? mark.toString() : null,
        marketValue: marketValue ? toMoneyString(marketValue) : null,
        unrealizedPnl: unrealised ? toMoneyString(unrealised) : null,
        realizedPnl: toMoneyString(p.realizedPnl.toString()),
        openedAt: p.openedAt.toISOString(),
      };
    });
  }

  async create(principal: Principal, input: CreatePortfolioInput): Promise<PortfolioSummary> {
    this.access.assertPermission(principal, Permission.PORTFOLIO_WRITE);

    const environment = input.environment as TradingEnvironment;
    if (environment === TradingEnvironment.LIVE && !config().ALLOW_LIVE_TRADING) {
      throw new AppError(
        'LIVE_TRADING_DISABLED',
        'This deployment cannot create live portfolios (ALLOW_LIVE_TRADING is false).',
      );
    }

    if (input.clientId) {
      const client = await this.db.client.findUnique({ where: { id: input.clientId } });
      if (!client) throw new AppError('NOT_FOUND', 'Client not found');
    }

    const initialCapital = dec(input.initialCapital);

    const portfolio = await this.db.$transaction(async (tx) => {
      const created = await tx.portfolio.create({
        data: {
          name: input.name,
          environment,
          clientId: input.clientId ?? null,
          baseCurrency: input.baseCurrency ?? 'USD',
          initialCapital: initialCapital.toFixed(8),
          cashBalance: initialCapital.toFixed(8),
          executionMode: (input.executionMode ?? ExecutionMode.MANUAL_APPROVAL) as ExecutionMode,
        },
      });

      await tx.riskLimit.create({
        data: {
          portfolioId: created.id,
          version: 1,
          isActive: true,
          maxDailyLoss: percentOf(initialCapital, DEFAULT_RISK_LIMITS.maxDailyLossPctOfCapital),
          maxWeeklyLoss: percentOf(initialCapital, DEFAULT_RISK_LIMITS.maxWeeklyLossPctOfCapital),
          maxPositionSize: percentOf(
            initialCapital,
            DEFAULT_RISK_LIMITS.maxPositionSizePctOfCapital,
          ),
          maxPortfolioExposurePct: DEFAULT_RISK_LIMITS.maxPortfolioExposurePct,
          maxSectorExposurePct: DEFAULT_RISK_LIMITS.maxSectorExposurePct,
          maxSymbolExposurePct: DEFAULT_RISK_LIMITS.maxSymbolExposurePct,
          maxOpenPositions: DEFAULT_RISK_LIMITS.maxOpenPositions,
          maxTradesPerDay: DEFAULT_RISK_LIMITS.maxTradesPerDay,
          maxConsecutiveLosses: DEFAULT_RISK_LIMITS.maxConsecutiveLosses,
          maxDrawdownPct: DEFAULT_RISK_LIMITS.maxDrawdownPct,
          changedById: principal.id,
          changeReason: 'Created with conservative defaults',
        },
      });

      if (input.clientId) {
        await tx.clientPortfolio.create({
          data: { clientId: input.clientId, portfolioId: created.id, isPrimary: true },
        });
      }

      await this.audit.record(
        {
          action: AuditAction.PORTFOLIO_CREATED,
          actorUserId: principal.id,
          entityType: 'Portfolio',
          entityId: created.id,
          portfolioId: created.id,
          clientId: input.clientId ?? null,
          environment,
          after: {
            name: created.name,
            environment,
            initialCapital: created.initialCapital.toString(),
            executionMode: created.executionMode,
          },
        },
        tx,
      );

      return created;
    });

    return this.summarise(portfolio, null);
  }

  async update(
    principal: Principal,
    portfolioId: string,
    patch: { name?: string; executionMode?: ExecutionMode; isActive?: boolean },
  ): Promise<PortfolioSummary> {
    const before = await this.access.assertPortfolioAccess(principal, portfolioId, {
      permission: Permission.PORTFOLIO_WRITE,
    });

    const updated = await this.db.$transaction(async (tx) => {
      const next = await tx.portfolio.update({
        where: { id: portfolioId },
        data: {
          ...(patch.name === undefined ? {} : { name: patch.name }),
          ...(patch.executionMode === undefined ? {} : { executionMode: patch.executionMode }),
          ...(patch.isActive === undefined ? {} : { isActive: patch.isActive }),
        },
      });
      await this.audit.record(
        {
          action: AuditAction.PORTFOLIO_MODIFIED,
          actorUserId: principal.id,
          entityType: 'Portfolio',
          entityId: portfolioId,
          portfolioId,
          environment: before.environment as TradingEnvironment,
          before: {
            name: before.name,
            executionMode: before.executionMode,
            isActive: before.isActive,
          },
          after: { name: next.name, executionMode: next.executionMode, isActive: next.isActive },
        },
        tx,
      );
      return next;
    });

    return this.summarise(updated, null);
  }

  /**
   * Marks a set of symbols. Returns an empty map when the portfolio's
   * environment has no market-data source — callers then report "no mark"
   * rather than substituting entry price for a real price.
   */
  private async markPrices(portfolio: Portfolio, symbols: string[]): Promise<Map<string, Decimal>> {
    const marks = new Map<string, Decimal>();
    if (symbols.length === 0) return marks;
    if (!this.brokers.isSupported(portfolio.environment as TradingEnvironment)) return marks;

    const broker = this.brokers.forPortfolio(portfolio);
    for (const symbol of new Set(symbols)) {
      try {
        const quote = await broker.getQuote(symbol);
        marks.set(symbol, quote.price);
      } catch {
        // A missing quote leaves the position unmarked; it is never invented.
      }
    }
    return marks;
  }

  private async summarise(
    portfolio: Portfolio,
    client: { id: string; name: string } | null,
  ): Promise<PortfolioSummary> {
    const [positions, riskLimit, previousSnapshot, openCount] = await Promise.all([
      this.db.position.findMany({
        where: { portfolioId: portfolio.id, status: 'OPEN' },
        select: { symbol: true, quantity: true, averageEntryPrice: true },
      }),
      this.db.riskLimit.findFirst({ where: { portfolioId: portfolio.id, isActive: true } }),
      this.db.portfolioSnapshot.findFirst({
        where: { portfolioId: portfolio.id, asOf: { lt: startOfUtcDay(new Date()) } },
        orderBy: { asOf: 'desc' },
      }),
      this.db.position.count({ where: { portfolioId: portfolio.id, status: 'OPEN' } }),
    ]);

    const marks = await this.markPrices(
      portfolio,
      positions.map((p) => p.symbol),
    );
    const cash = dec(portfolio.cashBalance.toString());
    const everyPositionMarked = positions.every((p) => marks.has(p.symbol));

    const positionsValue = everyPositionMarked
      ? positions.reduce(
          (sum, p) => sum.plus((marks.get(p.symbol) as Decimal).times(p.quantity.toString())),
          dec(0),
        )
      : null;
    const equity = positionsValue === null ? null : cash.plus(positionsValue);

    // Today's P&L needs yesterday's close plus today's external cash movement.
    let dailyPnl: Decimal | null = null;
    let dailyPnlPct: Decimal | null = null;
    if (equity !== null && previousSnapshot) {
      const netFlow = await this.netCashFlowSince(portfolio.id, startOfUtcDay(new Date()));
      const baseline = dec(previousSnapshot.equity.toString());
      dailyPnl = equity.minus(baseline).minus(netFlow);
      dailyPnlPct = percentChange(baseline, baseline.plus(dailyPnl));
    }

    const maxDailyLoss = riskLimit ? dec(riskLimit.maxDailyLoss.toString()) : null;
    const dailyRiskUsedPct =
      dailyPnl !== null && maxDailyLoss !== null && maxDailyLoss.gt(0) && dailyPnl.isNegative()
        ? dailyPnl.abs().dividedBy(maxDailyLoss).times(100)
        : dailyPnl !== null && maxDailyLoss !== null
          ? dec(0)
          : null;

    return {
      id: portfolio.id,
      name: portfolio.name,
      environment: portfolio.environment as TradingEnvironment,
      clientId: portfolio.clientId,
      clientName: client?.name ?? null,
      baseCurrency: portfolio.baseCurrency,
      executionMode: portfolio.executionMode as ExecutionMode,
      tradingState: portfolio.tradingState as TradingState,
      isActive: portfolio.isActive,
      cashBalance: toMoneyString(cash),
      positionsValue: positionsValue === null ? null : toMoneyString(positionsValue),
      equity: equity === null ? null : toMoneyString(equity),
      initialCapital: toMoneyString(portfolio.initialCapital.toString()),
      dailyPnl: dailyPnl === null ? null : toMoneyString(dailyPnl),
      dailyPnlPct: dailyPnlPct === null ? null : dailyPnlPct.toDecimalPlaces(4).toString(),
      openPositions: openCount,
      dailyRiskUsedPct:
        dailyRiskUsedPct === null ? null : dailyRiskUsedPct.toDecimalPlaces(2).toString(),
      killSwitchEngaged: portfolio.tradingState !== TradingState.ACTIVE,
    };
  }

  private async netCashFlowSince(portfolioId: string, since: Date): Promise<Decimal> {
    const flows = await this.db.cashFlow.findMany({
      where: { portfolioId, occurredAt: { gte: since } },
      select: { type: true, amount: true },
    });
    return flows.reduce(
      (sum, f) =>
        f.type === 'DEPOSIT' ? sum.plus(f.amount.toString()) : sum.minus(f.amount.toString()),
      dec(0),
    );
  }
}

function percentOf(capital: Decimal, pct: number): string {
  return capital.times(pct).toFixed(8);
}

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}
