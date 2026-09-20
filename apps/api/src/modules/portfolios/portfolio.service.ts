import type { Portfolio, PrismaClient } from '@prisma/client';
import {
  AuditAction,
  Decimal,
  ExecutionMode,
  Permission,
  TradingEnvironment,
  TradingState,
  UserRole,
  dec,
  riskProfileFor,
  percentChange,
  toMoneyString,
  type CreatePortfolioInput,
  type PortfolioObjective,
  type PortfolioSummary,
  type PositionDto,
} from '@zusu/shared';
import { config } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';
import type { AuditService } from '../audit/audit.service.js';
import type { BrokerRegistry } from '../broker/broker-registry.js';
import type { AccessControl, Principal } from '../rbac/access-control.js';
import { markPrices } from './marks.js';

export class PortfolioService {
  constructor(
    private readonly db: PrismaClient,
    private readonly access: AccessControl,
    private readonly audit: AuditService,
    private readonly brokers: BrokerRegistry,
  ) {}

  /**
   * Portfolios this principal may see.
   *
   * Closed ones are left out by default, which is what makes closing useful:
   * a portfolio made by mistake stops cluttering every picker in the app. They
   * are never deleted — see `deletionIsNotOffered` below — so `includeClosed`
   * brings them back for anyone who wants to reopen one.
   */
  async list(
    principal: Principal,
    options: { includeClosed?: boolean; clientId?: string | null } = {},
  ): Promise<PortfolioSummary[]> {
    this.access.assertPermission(principal, Permission.PORTFOLIO_READ);

    // `clientId: null` is a filter, not an absent one: "show me the portfolios
    // with nobody assigned" is a real question, and the answer to it is how a
    // person finds what they forgot to assign. `undefined` means no filter.
    const ownerFilter = options.clientId === undefined ? {} : { clientId: options.clientId };

    const portfolios = await this.db.portfolio.findMany({
      where: {
        AND: [
          this.access.portfolioScope(principal),
          options.includeClosed ? {} : { isActive: true },
          ownerFilter,
        ],
      },
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

    // Money for a retirement thirty years out and money being traded this week
    // cannot share a maximum drawdown. A portfolio with no stated objective
    // keeps the widest profile, which is what every portfolio had before.
    const objective = (input.objective ?? null) as PortfolioObjective | null;
    const limits = riskProfileFor(objective);

    const portfolio = await this.db.$transaction(async (tx) => {
      const created = await tx.portfolio.create({
        include: { client: { select: { id: true, name: true } } },
        data: {
          name: input.name,
          environment,
          clientId: input.clientId ?? null,
          objective,
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
          maxDailyLoss: percentOf(initialCapital, limits.maxDailyLossPctOfCapital),
          maxWeeklyLoss: percentOf(initialCapital, limits.maxWeeklyLossPctOfCapital),
          maxPositionSize: percentOf(initialCapital, limits.maxPositionSizePctOfCapital),
          maxPortfolioExposurePct: limits.maxPortfolioExposurePct,
          maxSectorExposurePct: limits.maxSectorExposurePct,
          maxSymbolExposurePct: limits.maxSymbolExposurePct,
          maxOpenPositions: limits.maxOpenPositions,
          maxTradesPerDay: limits.maxTradesPerDay,
          maxConsecutiveLosses: limits.maxConsecutiveLosses,
          maxDrawdownPct: limits.maxDrawdownPct,
          changedById: principal.id,
          // Names the objective, so a person reading the risk history later
          // can see why these particular numbers were the starting point.
          changeReason: objective
            ? `Created with the starting limits for ${objective}`
            : 'Created with conservative defaults',
        },
      });

      if (input.clientId) {
        await tx.clientPortfolio.create({
          data: { clientId: input.clientId, portfolioId: created.id, isPrimary: true },
        });
      }

      // Whoever made it can see it and trade it.
      //
      // Without this, a manager could create a portfolio and then not find it:
      // an administrator sees everything, but everyone else is scoped to
      // explicit grants and their own client's books, and a brand-new
      // portfolio has neither. The API said 201 and the thing vanished.
      if (principal.role !== UserRole.ADMIN) {
        await tx.portfolioAccess.create({
          data: { userId: principal.id, portfolioId: created.id, canTrade: true },
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

    // The owner, not null: a creation that reports the portfolio as unowned
    // sends the caller straight back to fetch what it already had.
    return this.summarise(portfolio, portfolio.client);
  }

  /**
   * Moves a portfolio between practice and paper.
   *
   * The binding of a portfolio to one environment is what makes "practice
   * credentials can never place a live order" structural rather than a
   * promise, and it holds: nothing moves to or from LIVE, and the schema does
   * not even offer it. Between DEMO and PAPER neither side can reach a broker,
   * so nothing about safety is at stake.
   *
   * What is at stake is the track record. A paper portfolio's numbers are
   * worth something because they came from real prices; one that spent its
   * first month on invented ones would carry that fiction forward silently. So
   * the switch draws a line: the instant is recorded, performance is measured
   * from it, and the holdings come across as declarations rather than as fills
   * this environment never saw. Nothing earlier is deleted — it is simply no
   * longer counted as though it happened here.
   */
  async switchEnvironment(
    principal: Principal,
    portfolioId: string,
    target: 'DEMO' | 'PAPER',
    at: Date = new Date(),
  ): Promise<PortfolioSummary> {
    const before = await this.access.assertPortfolioAccess(principal, portfolioId, {
      permission: Permission.PORTFOLIO_WRITE,
    });

    if (before.environment === TradingEnvironment.LIVE) {
      throw new AppError(
        'VALIDATION_FAILED',
        'A live portfolio cannot be moved. Its record is of real money and real fills, and ' +
          'relabelling that as practice would make a trading record something that can be ' +
          'rewritten.',
      );
    }

    if (before.environment === target) {
      throw new AppError('VALIDATION_FAILED', `This portfolio is already ${target}.`);
    }

    const updated = await this.db.$transaction(async (tx) => {
      const next = await tx.portfolio.update({
        where: { id: portfolioId },
        data: { environment: target as TradingEnvironment, environmentChangedAt: at },
        include: { client: { select: { id: true, name: true } } },
      });

      // The open positions come across, and become declarations: this
      // environment never filled them, and calling them TRADED here would
      // attribute a fill to prices that were never involved.
      await tx.position.updateMany({
        where: { portfolioId, status: 'OPEN' },
        data: { origin: 'IMPORTED' },
      });

      await this.audit.record(
        {
          action: AuditAction.ENVIRONMENT_SWITCHED,
          actorUserId: principal.id,
          entityType: 'Portfolio',
          entityId: portfolioId,
          portfolioId,
          environment: target as TradingEnvironment,
          before: { environment: before.environment },
          after: { environment: target, environmentChangedAt: at.toISOString() },
        },
        tx,
      );

      return next;
    });

    // The simulated venues hold their state in memory and key it by portfolio,
    // so a stale adapter would go on quoting the environment this portfolio
    // just left.
    this.brokers.reset();

    return this.summarise(updated, updated.client);
  }

  /**
   * Removes a portfolio and everything that belonged to it.
   *
   * Offered because the alternative was worse in practice: closing keeps a
   * portfolio for ever, and an installation used for a while accumulates
   * experiments that clutter every picker and every filter. A list nobody can
   * tidy is its own kind of unreliable.
   *
   * The record of a deletion survives the deletion. An entry naming the
   * portfolio, what it held and who asked is written immediately before the
   * row goes, and every entry the portfolio ever produced stays where it is —
   * `audit_logs.portfolio_id` keeps the id of something that no longer exists,
   * which is more honest than blanking it. Tidying a list cannot erase a
   * trading record, and that property is the one thing this must not cost.
   *
   * Two things are refused outright. A LIVE portfolio is a record of real
   * money and real fills and is never deletable. And the caller must type the
   * portfolio's name: a confirmation that can be clicked through without
   * reading is not a confirmation.
   */
  async remove(principal: Principal, portfolioId: string, confirmName: string): Promise<void> {
    const portfolio = await this.access.assertPortfolioAccess(principal, portfolioId, {
      permission: Permission.PORTFOLIO_WRITE,
    });

    if (portfolio.environment === TradingEnvironment.LIVE) {
      throw new AppError(
        'VALIDATION_FAILED',
        'A live portfolio cannot be deleted. It records real money and real fills, and a ' +
          'trading record is not something this application gets to erase.',
      );
    }

    if (confirmName.trim() !== portfolio.name) {
      throw new AppError(
        'VALIDATION_FAILED',
        `To delete this portfolio, type its name exactly: ${portfolio.name}`,
      );
    }

    const [positions, orders] = await Promise.all([
      this.db.position.count({ where: { portfolioId, status: 'OPEN' } }),
      this.db.order.count({ where: { portfolioId } }),
    ]);

    await this.db.$transaction(async (tx) => {
      // Before, not after. A failure between the two would otherwise leave a
      // deletion nobody recorded.
      await this.audit.record(
        {
          action: AuditAction.PORTFOLIO_DELETED,
          actorUserId: principal.id,
          entityType: 'Portfolio',
          entityId: portfolioId,
          portfolioId,
          environment: portfolio.environment as TradingEnvironment,
          before: {
            name: portfolio.name,
            environment: portfolio.environment,
            clientId: portfolio.clientId,
            objective: portfolio.objective,
            cashBalance: portfolio.cashBalance.toString(),
            openPositions: positions,
            orders,
          },
        },
        tx,
      );

      // Its positions, orders, executions, snapshots and cash flows go with
      // it — every one of those tables cascades from the portfolio. The audit
      // log does not, which is the whole point.
      await tx.portfolio.delete({ where: { id: portfolioId } });
    });

    this.brokers.reset();
  }

  async update(
    principal: Principal,
    portfolioId: string,
    patch: {
      name?: string;
      executionMode?: ExecutionMode;
      isActive?: boolean;
      clientId?: string | null;
      objective?: PortfolioObjective | null;
    },
  ): Promise<PortfolioSummary> {
    const before = await this.access.assertPortfolioAccess(principal, portfolioId, {
      permission: Permission.PORTFOLIO_WRITE,
    });

    // Reassigning an owner is a real correction — a portfolio set up under the
    // wrong person — so it is allowed, and audited with both sides.
    if (patch.clientId) {
      const client = await this.db.client.findUnique({ where: { id: patch.clientId } });
      if (!client) throw new AppError('NOT_FOUND', 'Owner not found');
    }

    // Closing hides a portfolio from every list, and a hidden book you still
    // hold shares in is a book nobody is watching. Sell or transfer first.
    if (patch.isActive === false && before.isActive) {
      const open = await this.db.position.count({ where: { portfolioId, status: 'OPEN' } });
      if (open > 0) {
        throw new AppError(
          'CONFLICT',
          `This portfolio still holds ${String(open)} open position(s). Close them first — ` +
            'a portfolio hidden from the list while it is still in a trade is one nobody is ' +
            'watching.',
        );
      }
    }

    const updated = await this.db.$transaction(async (tx) => {
      const next = await tx.portfolio.update({
        where: { id: portfolioId },
        data: {
          ...(patch.name === undefined ? {} : { name: patch.name }),
          ...(patch.executionMode === undefined ? {} : { executionMode: patch.executionMode }),
          ...(patch.isActive === undefined ? {} : { isActive: patch.isActive }),
          ...(patch.clientId === undefined ? {} : { clientId: patch.clientId }),
          ...(patch.objective === undefined ? {} : { objective: patch.objective }),
        },
        include: { client: { select: { id: true, name: true } } },
      });

      // The owner link is kept in step with the column. Leaving them to drift
      // would make the reporting relation disagree with what the portfolio
      // page shows about the same portfolio.
      if (patch.clientId !== undefined) {
        await tx.clientPortfolio.deleteMany({ where: { portfolioId, isPrimary: true } });
        if (patch.clientId) {
          await tx.clientPortfolio.create({
            data: { clientId: patch.clientId, portfolioId, isPrimary: true },
          });
        }
      }
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
            clientId: before.clientId,
            objective: before.objective,
          },
          after: {
            name: next.name,
            executionMode: next.executionMode,
            isActive: next.isActive,
            clientId: next.clientId,
            objective: next.objective,
          },
        },
        tx,
      );
      return next;
    });

    // The owner, not null. Passing null here reported every edited portfolio as
    // unowned, which nobody noticed while the owner was invisible on screen and
    // which would read as "renaming it cleared the owner" now that it is not.
    return this.summarise(updated, updated.client);
  }

  /** Delegates to the shared helper, so every valuation uses one price source. */
  private async markPrices(portfolio: Portfolio, symbols: string[]): Promise<Map<string, Decimal>> {
    return markPrices(this.brokers, portfolio, symbols);
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
        where: {
          portfolioId: portfolio.id,
          asOf: {
            lt: startOfUtcDay(new Date()),
            // Never across an environment switch. A snapshot taken under
            // invented prices, compared against a mark from the real market,
            // produces a day's "gain" that is entirely the price source
            // changing — the first number a person sees after switching, and a
            // wholly fictional one. With nothing to compare against, the
            // dashboard says so, as it does on a portfolio's first day.
            ...(portfolio.environmentChangedAt ? { gte: portfolio.environmentChangedAt } : {}),
          },
        },
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
      objective: portfolio.objective,
      environmentChangedAt: portfolio.environmentChangedAt?.toISOString() ?? null,
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

  /**
   * Money that crossed the portfolio's boundary since a moment — and only
   * that.
   *
   * Today's P&L is today's change in equity *minus* this, so what belongs here
   * decides whether a number is performance or somebody's wire:
   *
   *   - **Deposits, withdrawals and transfers in belong.** They move equity
   *     without anyone having earned or lost anything.
   *   - **A dividend does not.** It raised equity because of what was held,
   *     which is exactly what P&L is supposed to report. Subtracting it would
   *     show a dividend day as flat.
   *
   * Amounts are stored already signed — a withdrawal is negative in the column
   * — so this sums them. It used to negate everything that was not a deposit,
   * which turned a withdrawal into a contribution and reported the day as
   * twice the loss it was.
   */
  private async netCashFlowSince(portfolioId: string, since: Date): Promise<Decimal> {
    const flows = await this.db.cashFlow.findMany({
      where: {
        portfolioId,
        occurredAt: { gte: since },
        type: { in: ['DEPOSIT', 'WITHDRAWAL', 'TRANSFER_IN'] },
      },
      select: { amount: true },
    });
    return flows.reduce((sum, f) => sum.plus(f.amount.toString()), dec(0));
  }
}

function percentOf(capital: Decimal, pct: number): string {
  return capital.times(pct).toFixed(8);
}

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/**
 * Deleting, and what it does not touch.
 *
 * This was refused for a long time, and the reason was mechanical rather than
 * chosen: `audit_logs.portfolio_id` was a foreign key with ON DELETE SET NULL,
 * and `audit_logs` refuses UPDATE in a trigger, so a delete asked the database
 * to rewrite an append-only log and was told no.
 *
 * The foreign key was the wrong tool for that column. An immutable log records
 * what happened, and "this happened to portfolio X" stays true after X is
 * gone; blanking the reference would destroy information to preserve a
 * constraint about rows that are no longer there. So the column keeps its id
 * and is no longer a foreign key, the log keeps every entry the portfolio ever
 * produced, and one more is written just before the row goes, naming what was
 * deleted, what it held and who asked.
 *
 * Closing remains, and is still the right answer for a portfolio with a
 * history worth keeping: it leaves every picker and can be reopened. Deleting
 * is for the experiments, and it takes their positions, orders, executions,
 * snapshots and cash flows with them.
 */
export const deletionIsOffered =
  'A portfolio can be deleted, and its audit history cannot be. Every entry it produced stays, ' +
  'including one written just before it went that names what was deleted and by whom.';
