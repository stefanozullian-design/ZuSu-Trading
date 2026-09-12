import type { PrismaClient } from '@prisma/client';
import { Decimal, Permission, dec } from '@zusu/shared';
import { AppError } from '../../lib/errors.js';
import type { AuditService } from '../audit/audit.service.js';
import type { AccessControl, Principal } from '../rbac/access-control.js';

/**
 * Portfolio accounting (§42, §43).
 *
 * The rule this module exists for: **a deposit is not a profit.** An account
 * that went from 10,000 to 20,000 because somebody wired in 10,000 has
 * returned nothing, and the arithmetic that hides that is the most common way
 * a performance figure lies. So every external cash movement is a row, and
 * both return measures are computed with those rows removed:
 *
 *   - **Time-weighted return** answers "how did the strategy do", by chaining
 *     the return of each period between cash movements. It is the figure to
 *     compare against an index, because it does not reward good timing of
 *     deposits.
 *
 *   - **Money-weighted return** (an internal rate of return) answers "how did
 *     *this investor* do", because it does weight the size and timing of the
 *     flows. The two differ, sometimes a lot, and reporting only the flattering
 *     one is a choice this module refuses to make for you.
 *
 * Both are null rather than approximated when the inputs cannot support them —
 * fewer than two snapshots, or a period that starts from zero equity.
 */

export interface SnapshotView {
  asOf: Date;
  cashBalance: string;
  positionsValue: string;
  equity: string;
  netCashFlow: string;
  realizedPnl: string;
  unrealizedPnl: string;
  feesTotal: string;
  openPositions: number;
}

export interface PerformanceReport {
  portfolioId: string;
  from: Date;
  to: Date;
  openingEquity: string;
  closingEquity: string;
  netDeposits: string;
  /** Change in equity minus external flows — the part the trading produced. */
  investmentGain: string;
  /** Chained period returns, as a percentage. Null without two snapshots. */
  timeWeightedReturnPct: string | null;
  /** Internal rate of return over the flows, annualised. Null when unsolvable. */
  moneyWeightedReturnPct: string | null;
  realizedPnl: string;
  unrealizedPnl: string;
  feesPaid: string;
  maxDrawdownPct: string;
  snapshots: SnapshotView[];
  /** Assumptions a reader needs in order to use these numbers. */
  notes: string[];
}

/** Below this, an annualised internal rate of return is meaningless. */
const MIN_DAYS_FOR_IRR = 7;

const NOTES = [
  'A deposit or withdrawal is never counted as profit: both return measures remove external cash flows.',
  'Time-weighted return chains the return of each period between snapshots, and treats a cash flow as arriving at the start of its period — capital the trading had to work with.',
  'Money-weighted return is an internal rate of return over the dated flows, annualised, and answers a different question from the time-weighted one. It is withheld for windows shorter than a week, where annualising produces a number in the thousands of percent.',
  'A period is only as fine-grained as its snapshots: without a daily snapshot, a day of movement inside one period is invisible to the chain.',
];

export class PerformanceService {
  constructor(
    private readonly db: PrismaClient,
    private readonly access: AccessControl,
    private readonly audit: AuditService,
  ) {}

  /**
   * Writes the snapshot for one instant.
   *
   * Idempotent on (portfolio, asOf) so re-running a day recomputes it rather
   * than producing two versions of the same close. The `daily-snapshot` job
   * calls it once a day and the route calls it on demand; the absence of a
   * snapshot is visible in the report rather than filled in.
   */
  async writeSnapshot(portfolioId: string, asOf: Date): Promise<SnapshotView> {
    const portfolio = await this.db.portfolio.findUnique({ where: { id: portfolioId } });
    if (!portfolio) throw new AppError('NOT_FOUND', 'Portfolio not found');

    const dayStart = startOfUtcDay(asOf);
    const positions = await this.db.position.findMany({
      where: { portfolioId, status: 'OPEN' },
    });

    let positionsValue = dec(0);
    let unrealizedPnl = dec(0);
    for (const position of positions) {
      const quantity = dec(position.quantity.toString());
      const mark = await this.markFor(position.symbol, asOf);
      // A position with no stored price is marked at its own cost rather than
      // at zero: a missing quote is not a loss.
      const price = mark ?? dec(position.averageEntryPrice.toString());
      positionsValue = positionsValue.plus(price.times(quantity));
      unrealizedPnl = unrealizedPnl.plus(
        price.minus(dec(position.averageEntryPrice.toString())).times(quantity),
      );
    }

    const [flows, realized, fees, closedRealized] = await Promise.all([
      this.db.cashFlow.aggregate({
        where: { portfolioId, occurredAt: { gte: dayStart, lte: asOf } },
        _sum: { amount: true },
      }),
      this.db.position.aggregate({
        where: { portfolioId, status: 'OPEN' },
        _sum: { realizedPnl: true },
      }),
      this.db.fee.aggregate({
        where: { portfolioId, incurredAt: { lte: asOf } },
        _sum: { amount: true },
      }),
      this.db.position.aggregate({
        where: { portfolioId, status: 'CLOSED' },
        _sum: { realizedPnl: true },
      }),
    ]);

    const cash = dec(portfolio.cashBalance.toString());
    const realizedTotal = dec(realized._sum.realizedPnl?.toString() ?? '0').plus(
      dec(closedRealized._sum.realizedPnl?.toString() ?? '0'),
    );

    const data = {
      cashBalance: cash.toString(),
      positionsValue: positionsValue.toString(),
      equity: cash.plus(positionsValue).toString(),
      netCashFlow: dec(flows._sum.amount?.toString() ?? '0').toString(),
      realizedPnl: realizedTotal.toString(),
      unrealizedPnl: unrealizedPnl.toString(),
      feesTotal: dec(fees._sum.amount?.toString() ?? '0').toString(),
      openPositions: positions.length,
    };

    const row = await this.db.portfolioSnapshot.upsert({
      where: { portfolioId_asOf: { portfolioId, asOf } },
      create: { portfolioId, asOf, ...data },
      update: data,
    });

    return toSnapshot(row);
  }

  /** Records money in or out. Never profit, and never silently. */
  async recordCashFlow(
    principal: Principal,
    input: {
      portfolioId: string;
      type: 'DEPOSIT' | 'WITHDRAWAL';
      amount: string;
      occurredAt?: Date;
      note?: string;
    },
  ): Promise<{ id: string; amount: string; type: string }> {
    const portfolio = await this.access.assertPortfolioAccess(principal, input.portfolioId, {
      permission: Permission.PORTFOLIO_WRITE,
    });

    const amount = dec(input.amount);
    if (amount.lessThanOrEqualTo(0)) {
      throw new AppError(
        'VALIDATION_FAILED',
        'The amount must be positive; the type says which way it goes',
      );
    }

    const occurredAt = input.occurredAt ?? new Date();
    const signed = input.type === 'DEPOSIT' ? amount : amount.negated();
    const cash = dec(portfolio.cashBalance.toString());
    if (input.type === 'WITHDRAWAL' && amount.greaterThan(cash)) {
      throw new AppError(
        'VALIDATION_FAILED',
        `A withdrawal of ${amount.toFixed(2)} exceeds the ${cash.toFixed(2)} of cash on hand.`,
      );
    }

    const flow = await this.db.$transaction(async (tx) => {
      const created = await tx.cashFlow.create({
        data: {
          portfolioId: input.portfolioId,
          type: input.type,
          // Stored signed, so a sum over the column is the net movement and
          // cannot be got wrong by a reader who forgets the type.
          amount: signed.toString(),
          occurredAt,
          note: input.note ?? null,
        },
      });
      await tx.portfolio.update({
        where: { id: input.portfolioId },
        data: { cashBalance: cash.plus(signed).toString() },
      });
      return created;
    });

    await this.audit.record({
      action: 'PORTFOLIO_UPDATED',
      actorUserId: principal.id,
      actorType: 'USER',
      entityType: 'cashFlow',
      entityId: flow.id,
      portfolioId: input.portfolioId,
      after: { type: input.type, amount: signed.toString() },
      metadata: input.note ? { note: input.note } : null,
    });

    return { id: flow.id, amount: signed.toString(), type: input.type };
  }

  /** The performance report for a window, with both return measures. */
  async report(
    principal: Principal,
    portfolioId: string,
    window: { from: Date; to: Date },
  ): Promise<PerformanceReport> {
    await this.access.assertPortfolioAccess(principal, portfolioId, {
      permission: Permission.PERFORMANCE_READ,
    });

    const snapshots = await this.db.portfolioSnapshot.findMany({
      where: { portfolioId, asOf: { gte: window.from, lte: window.to } },
      orderBy: { asOf: 'asc' },
    });

    const flows = await this.db.cashFlow.findMany({
      where: { portfolioId, occurredAt: { gte: window.from, lte: window.to } },
      orderBy: { occurredAt: 'asc' },
    });

    const views = snapshots.map(toSnapshot);
    const opening = views[0];
    const closing = views[views.length - 1];

    const netDeposits = flows.reduce(
      (total, flow) => total.plus(dec(flow.amount.toString())),
      dec(0),
    );
    const openingEquity = opening ? dec(opening.equity) : dec(0);
    const closingEquity = closing ? dec(closing.equity) : dec(0);

    return {
      portfolioId,
      from: window.from,
      to: window.to,
      openingEquity: openingEquity.toString(),
      closingEquity: closingEquity.toString(),
      netDeposits: netDeposits.toString(),
      // The part the trading produced: everything else is somebody's wire.
      investmentGain: closingEquity.minus(openingEquity).minus(netDeposits).toString(),
      timeWeightedReturnPct: timeWeightedReturn(views),
      moneyWeightedReturnPct: moneyWeightedReturn(
        openingEquity,
        closingEquity,
        flows.map((flow) => ({ at: flow.occurredAt, amount: dec(flow.amount.toString()) })),
        window,
      ),
      realizedPnl: closing?.realizedPnl ?? '0',
      unrealizedPnl: closing?.unrealizedPnl ?? '0',
      feesPaid: closing?.feesTotal ?? '0',
      maxDrawdownPct: maxDrawdown(views).toString(),
      snapshots: views,
      notes: [
        ...NOTES,
        ...(views.length < 2
          ? [
              'Fewer than two snapshots in this window, so the time-weighted return is not reported rather than guessed from one point.',
            ]
          : []),
      ],
    };
  }

  private async markFor(symbol: string, asOf: Date): Promise<Decimal | null> {
    const candle = await this.db.marketDataCandle.findFirst({
      where: { symbol, openTime: { lte: asOf } },
      orderBy: { openTime: 'desc' },
      select: { close: true },
    });
    return candle ? dec(candle.close.toString()) : null;
  }
}

/**
 * Chained period returns.
 *
 * Each period's return removes that period's external flow, so a deposit
 * cannot appear as performance. The flow is treated as arriving at the *start*
 * of its period, which means it counts as capital the trading had to work
 * with: money deposited on Tuesday and traded on Tuesday earned its return on
 * the larger base, and the alternative convention would credit the strategy
 * with a return on capital it did not have yet.
 *
 * The convention is stated in the report's notes, because an unstated
 * convention is how two systems disagree about the same account forever.
 */
function timeWeightedReturn(snapshots: SnapshotView[]): string | null {
  if (snapshots.length < 2) return null;

  let compounded = dec(1);
  let usable = 0;

  for (let i = 1; i < snapshots.length; i += 1) {
    const previous = snapshots[i - 1];
    const current = snapshots[i];
    if (!previous || !current) continue;

    const base = dec(previous.equity).plus(dec(current.netCashFlow));
    if (base.lessThanOrEqualTo(0)) continue;

    compounded = compounded.times(dec(current.equity).div(base));
    usable += 1;
  }

  if (usable === 0) return null;
  return compounded.minus(1).times(100).toString();
}

/**
 * Internal rate of return, solved by bisection.
 *
 * Bisection rather than Newton's method because it cannot diverge: an IRR
 * that silently failed to converge and returned its last guess would be a
 * plausible-looking number with nothing behind it. If no rate in a wide
 * bracket fits the cash flows, this returns null.
 */
function moneyWeightedReturn(
  openingEquity: Decimal,
  closingEquity: Decimal,
  flows: { at: Date; amount: Decimal }[],
  window: { from: Date; to: Date },
): string | null {
  const days = (window.to.getTime() - window.from.getTime()) / 86_400_000;
  // Annualising a two-day IRR gives a number in the millions of percent. It
  // is arithmetically defined and worth nothing, so it is withheld.
  if (days < MIN_DAYS_FOR_IRR) return null;
  const years = days / 365.25;
  if (openingEquity.lessThanOrEqualTo(0) && flows.length === 0) return null;

  // The series a person actually experienced: money in is negative, the
  // closing value is the final inflow.
  const series: { years: number; amount: number }[] = [
    { years: 0, amount: -Number(openingEquity.toString()) },
    ...flows.map((flow) => ({
      years: (flow.at.getTime() - window.from.getTime()) / (365.25 * 86_400_000),
      amount: -Number(flow.amount.toString()),
    })),
    { years, amount: Number(closingEquity.toString()) },
  ];

  const npv = (rate: number): number =>
    series.reduce((total, entry) => total + entry.amount / (1 + rate) ** entry.years, 0);

  let low = -0.9999;
  // Wide enough for a good year on a small account, and bounded so a failure
  // to bracket the root is reported rather than papered over.
  let high = 100;
  const atLow = npv(low);
  const atHigh = npv(high);
  // No sign change means no root in the bracket; saying so beats inventing one.
  if (!Number.isFinite(atLow) || !Number.isFinite(atHigh) || atLow * atHigh > 0) return null;

  for (let i = 0; i < 200; i += 1) {
    const mid = (low + high) / 2;
    const value = npv(mid);
    if (Math.abs(value) < 1e-9) return dec(mid * 100).toString();
    if (npv(low) * value < 0) high = mid;
    else low = mid;
  }

  return dec(((low + high) / 2) * 100).toString();
}

function maxDrawdown(snapshots: SnapshotView[]): Decimal {
  let peak = dec(0);
  let worst = dec(0);
  for (const snapshot of snapshots) {
    const equity = dec(snapshot.equity);
    if (equity.greaterThan(peak)) peak = equity;
    if (peak.lessThanOrEqualTo(0)) continue;
    const fall = peak.minus(equity).div(peak).times(100);
    if (fall.greaterThan(worst)) worst = fall;
  }
  return worst;
}

function startOfUtcDay(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

function toSnapshot(row: {
  asOf: Date;
  cashBalance: { toString(): string };
  positionsValue: { toString(): string };
  equity: { toString(): string };
  netCashFlow: { toString(): string };
  realizedPnl: { toString(): string };
  unrealizedPnl: { toString(): string };
  feesTotal: { toString(): string };
  openPositions: number;
}): SnapshotView {
  return {
    asOf: row.asOf,
    cashBalance: row.cashBalance.toString(),
    positionsValue: row.positionsValue.toString(),
    equity: row.equity.toString(),
    netCashFlow: row.netCashFlow.toString(),
    realizedPnl: row.realizedPnl.toString(),
    unrealizedPnl: row.unrealizedPnl.toString(),
    feesTotal: row.feesTotal.toString(),
    openPositions: row.openPositions,
  };
}
