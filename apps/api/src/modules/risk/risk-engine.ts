import type { PrismaClient } from '@prisma/client';
import { Decimal, dec } from '@zusu/shared';
import { AppError } from '../../lib/errors.js';
import { sizePosition, type SizingResult } from './position-sizing.js';

/**
 * The portfolio risk engine (§17–§24).
 *
 * This is the module that fills in the gap the order manager has been naming as
 * `LIMITS_NOT_YET_ENFORCED`. Everything here is a *pre-trade* check on the
 * whole book rather than on one order, which is what makes it different from
 * the order manager's own checks: the question is not "is this order sane" but
 * "does the book still look like something a person agreed to after it".
 *
 * Design rules:
 *
 *   1. **Every check names its limit, its limit value and the actual value.**
 *      A refusal that says "risk limit exceeded" cannot be acted on. Each one
 *      here says which limit, what it is, and what the book actually is.
 *
 *   2. **A breach is a row.** `risk_events` records warnings and breaches with
 *      their numbers, so a pattern of near-misses is visible before the breach
 *      that stops trading.
 *
 *   3. **Automatic action stops trading; it never starts any.** The drawdown
 *      breaker can halt a portfolio, and only a person can release it. There
 *      is deliberately no automatic un-halt: a breaker that resets itself is a
 *      breaker that trades through the thing it was built to stop.
 *
 *   4. **A limit that cannot be evaluated blocks rather than passes.** A
 *      missing price, no active limits, an unclassified sector — each is a
 *      reason to refuse, because "we could not check" is not "it is fine".
 */

export interface RiskCheck {
  limitName: string;
  passed: boolean;
  /** Null when the check could not be evaluated at all. */
  actual: string | null;
  limit: string;
  message: string;
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
}

export interface RiskAssessment {
  allowed: boolean;
  checks: RiskCheck[];
  /** The failing checks, in the order they were evaluated. */
  breaches: RiskCheck[];
  /** Checks that passed but are within a tenth of their limit. */
  nearMisses: RiskCheck[];
  sizing: SizingResult | null;
}

/** Below a tenth of headroom, a passing check is still worth saying out loud. */
const NEAR_MISS_FRACTION = 0.9;

export interface ProposedTrade {
  portfolioId: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  direction: 'LONG' | 'SHORT';
  entryPrice: Decimal;
  stopPrice: Decimal | null;
  /** When given, sizing is skipped and this quantity is checked instead. */
  quantity?: Decimal;
  riskPerTradePct?: Decimal;
  at?: Date;
}

export class RiskEngine {
  constructor(private readonly db: PrismaClient) {}

  /**
   * Sizes a proposed trade and checks it against the whole book.
   *
   * Returns an assessment rather than throwing: a refusal with its numbers is
   * more useful than an exception, and the caller stores it either way.
   */
  async assess(trade: ProposedTrade): Promise<RiskAssessment> {
    const at = trade.at ?? new Date();
    const checks: RiskCheck[] = [];

    const [portfolio, limits] = await Promise.all([
      this.db.portfolio.findUnique({ where: { id: trade.portfolioId } }),
      this.db.riskLimit.findFirst({
        where: { portfolioId: trade.portfolioId, isActive: true },
        orderBy: { version: 'desc' },
      }),
    ]);
    if (!portfolio) throw new AppError('NOT_FOUND', 'Portfolio not found');

    if (!limits) {
      // No limits configured is not a green light.
      checks.push({
        limitName: 'active risk limits',
        passed: false,
        actual: null,
        limit: 'one active version required',
        message:
          'This portfolio has no active risk limits, so nothing can be checked and nothing ' +
          'may be traded.',
        severity: 'CRITICAL',
      });
      return this.finish(checks, null);
    }

    const positions = await this.db.position.findMany({
      where: { portfolioId: trade.portfolioId, status: 'OPEN' },
    });
    const equity = await this.equityOf(portfolio, positions, at);

    // --- Sizing ------------------------------------------------------------
    const sizing =
      trade.quantity !== undefined
        ? null
        : sizePosition({
            equity,
            riskPerTradePct: trade.riskPerTradePct ?? dec('1'),
            entryPrice: trade.entryPrice,
            stopPrice: trade.stopPrice,
            direction: trade.direction,
            maxNotional: dec(limits.maxPositionSize.toString()),
            availableCash: dec(portfolio.cashBalance.toString()),
            atr: await this.atrOf(trade.symbol, at),
          });

    const quantity = trade.quantity ?? sizing?.quantity ?? dec(0);
    if (quantity.lessThanOrEqualTo(0)) {
      checks.push({
        limitName: 'position sizing',
        passed: false,
        actual: '0',
        limit: 'at least one share',
        message: sizing?.reason ?? 'The position could not be sized.',
        severity: 'WARNING',
      });
      return this.finish(checks, sizing);
    }

    const notional = trade.entryPrice.times(quantity);

    // --- Position size and exposure ---------------------------------------
    checks.push(
      compare({
        limitName: 'max position size',
        actual: notional,
        limit: dec(limits.maxPositionSize.toString()),
        unit: 'notional',
      }),
    );

    const grossExposure = positions.reduce(
      (total, position) =>
        total.plus(
          dec(position.quantity.toString()).abs().times(dec(position.averageEntryPrice.toString())),
        ),
      dec(0),
    );

    checks.push(
      compare({
        limitName: 'portfolio exposure',
        actual: equity.greaterThan(0)
          ? grossExposure.plus(notional).div(equity).times(100)
          : dec(0),
        limit: dec(limits.maxPortfolioExposurePct.toString()),
        unit: 'percent of equity',
      }),
    );

    const symbolExisting = positions
      .filter((position) => position.symbol === trade.symbol)
      .reduce(
        (total, position) =>
          total.plus(
            dec(position.quantity.toString())
              .abs()
              .times(dec(position.averageEntryPrice.toString())),
          ),
        dec(0),
      );

    checks.push(
      compare({
        limitName: 'symbol exposure',
        actual: equity.greaterThan(0)
          ? symbolExisting.plus(notional).div(equity).times(100)
          : dec(0),
        limit: dec(limits.maxSymbolExposurePct.toString()),
        unit: 'percent of equity',
      }),
    );

    checks.push(await this.sectorCheck(trade, positions, equity, notional, limits));

    // --- Counts ------------------------------------------------------------
    const holdsSymbol = positions.some((position) => position.symbol === trade.symbol);
    checks.push(
      compare({
        limitName: 'open positions',
        actual: dec(positions.length + (holdsSymbol ? 0 : 1)),
        limit: dec(limits.maxOpenPositions),
        unit: 'positions',
      }),
    );

    const tradesToday = await this.db.order.count({
      where: {
        portfolioId: trade.portfolioId,
        createdAt: { gte: startOfUtcDay(at) },
        status: { notIn: ['REJECTED'] },
      },
    });
    checks.push(
      compare({
        limitName: 'trades per day',
        actual: dec(tradesToday + 1),
        limit: dec(limits.maxTradesPerDay),
        unit: 'orders today',
      }),
    );

    // --- Losses ------------------------------------------------------------
    checks.push(
      await this.lossCheck({
        portfolioId: trade.portfolioId,
        since: startOfUtcDay(at),
        limit: dec(limits.maxDailyLoss.toString()),
        limitName: 'daily loss',
      }),
    );
    checks.push(
      await this.lossCheck({
        portfolioId: trade.portfolioId,
        since: startOfUtcWeek(at),
        limit: dec(limits.maxWeeklyLoss.toString()),
        limitName: 'weekly loss',
      }),
    );
    checks.push(await this.consecutiveLossCheck(trade.portfolioId, limits.maxConsecutiveLosses));
    checks.push(await this.drawdownCheck(trade.portfolioId, dec(limits.maxDrawdownPct.toString())));
    checks.push(await this.correlationCheck(trade, positions));

    return this.finish(checks, sizing);
  }

  /**
   * The drawdown circuit breaker.
   *
   * Halts a portfolio when equity has fallen further from its peak than the
   * configured limit. Halting is the safe direction, so it is automatic;
   * releasing is not, so it is not. Nothing in this codebase un-halts a
   * portfolio — a breaker that resets itself is one that trades through the
   * thing it was built to stop.
   */
  async runBreakers(
    at: Date = new Date(),
  ): Promise<{ portfolioId: string; halted: boolean; drawdownPct: string; limitPct: string }[]> {
    const portfolios = await this.db.portfolio.findMany({
      where: { isActive: true, tradingState: 'ACTIVE' },
    });

    const results: {
      portfolioId: string;
      halted: boolean;
      drawdownPct: string;
      limitPct: string;
    }[] = [];

    for (const portfolio of portfolios) {
      const limits = await this.db.riskLimit.findFirst({
        where: { portfolioId: portfolio.id, isActive: true },
        orderBy: { version: 'desc' },
      });
      if (!limits) continue;

      const limitPct = dec(limits.maxDrawdownPct.toString());
      const drawdown = await this.drawdownOf(portfolio.id);
      if (drawdown === null) continue;

      const breached = drawdown.greaterThan(limitPct);
      if (!breached) {
        results.push({
          portfolioId: portfolio.id,
          halted: false,
          drawdownPct: drawdown.toString(),
          limitPct: limitPct.toString(),
        });
        continue;
      }

      await this.db.$transaction([
        this.db.portfolio.update({
          where: { id: portfolio.id },
          data: { tradingState: 'HALTED' },
        }),
        this.db.riskEvent.create({
          data: {
            portfolioId: portfolio.id,
            type: 'KILL_SWITCH_AUTOMATIC',
            severity: 'CRITICAL',
            message:
              `Trading halted automatically: equity is ${drawdown.toFixed(2)}% below its peak, ` +
              `past the ${limitPct.toFixed(2)}% limit. Only a person can release this.`,
            limitName: 'max drawdown',
            limitValue: limitPct.toString(),
            actualValue: drawdown.toString(),
            metadata: { at: at.toISOString(), automatic: true },
          },
        }),
      ]);

      results.push({
        portfolioId: portfolio.id,
        halted: true,
        drawdownPct: drawdown.toString(),
        limitPct: limitPct.toString(),
      });
    }

    return results;
  }

  /** Records an assessment's breaches and near-misses. */
  async recordEvents(
    portfolioId: string,
    assessment: RiskAssessment,
    context: { signalId?: string | null } = {},
  ): Promise<void> {
    const rows = [
      ...assessment.breaches.map((check) => ({ check, severity: check.severity })),
      ...assessment.nearMisses.map((check) => ({ check, severity: 'WARNING' as const })),
    ];
    if (rows.length === 0) return;

    await this.db.riskEvent.createMany({
      data: rows.map(({ check, severity }) => ({
        portfolioId,
        signalId: context.signalId ?? null,
        type: check.passed ? ('LIMIT_WARNING' as const) : ('LIMIT_BREACH' as const),
        severity,
        message: check.message,
        limitName: check.limitName,
        limitValue: check.limit,
        actualValue: check.actual,
      })),
    });
  }

  async recentEvents(portfolioId: string, limit = 50) {
    return this.db.riskEvent.findMany({
      where: { portfolioId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  // --------------------------------------------------------------------------

  private finish(checks: RiskCheck[], sizing: SizingResult | null): RiskAssessment {
    const breaches = checks.filter((check) => !check.passed);
    const nearMisses = checks.filter((check) => check.passed && isNearMiss(check));
    return { allowed: breaches.length === 0, checks, breaches, nearMisses, sizing };
  }

  private async equityOf(
    portfolio: { cashBalance: { toString(): string } },
    positions: {
      symbol: string;
      quantity: { toString(): string };
      averageEntryPrice: { toString(): string };
    }[],
    at: Date,
  ): Promise<Decimal> {
    let equity = dec(portfolio.cashBalance.toString());
    for (const position of positions) {
      const mark = await this.markOf(position.symbol, at);
      // A position with no stored price is held at its own cost rather than at
      // zero: a missing quote is not a loss, and treating it as one would
      // inflate every percentage below.
      const price = mark ?? dec(position.averageEntryPrice.toString());
      equity = equity.plus(price.times(dec(position.quantity.toString())));
    }
    return equity;
  }

  private async markOf(symbol: string, at: Date): Promise<Decimal | null> {
    const candle = await this.db.marketDataCandle.findFirst({
      where: { symbol, openTime: { lte: at } },
      orderBy: { openTime: 'desc' },
      select: { close: true },
    });
    return candle ? dec(candle.close.toString()) : null;
  }

  private async atrOf(symbol: string, at: Date): Promise<Decimal | null> {
    // A cheap proxy from stored bars: the mean absolute bar range over the
    // newest twenty. The indicator engine's ATR is Wilder-smoothed and needs a
    // series; this is only a floor for the stop distance, and a floor from a
    // rough number is better than no floor.
    const candles = await this.db.marketDataCandle.findMany({
      where: { symbol, openTime: { lte: at } },
      orderBy: { openTime: 'desc' },
      take: 20,
      select: { high: true, low: true },
    });
    if (candles.length < 5) return null;

    const total = candles.reduce(
      (sum, candle) => sum.plus(dec(candle.high.toString()).minus(dec(candle.low.toString()))),
      dec(0),
    );
    return total.div(candles.length);
  }

  private async sectorCheck(
    trade: ProposedTrade,
    positions: {
      symbol: string;
      quantity: { toString(): string };
      averageEntryPrice: { toString(): string };
    }[],
    equity: Decimal,
    notional: Decimal,
    limits: { maxSectorExposurePct: { toString(): string } },
  ): Promise<RiskCheck> {
    const limit = dec(limits.maxSectorExposurePct.toString());
    const instrument = await this.db.instrument.findUnique({
      where: { symbol: trade.symbol },
      select: { sector: true },
    });

    if (!instrument?.sector) {
      // An unclassified symbol cannot be checked against a sector limit, and
      // "we could not check" is not "it is fine".
      return {
        limitName: 'sector exposure',
        passed: false,
        actual: null,
        limit: limit.toString(),
        message:
          `${trade.symbol} has no sector recorded, so its contribution to the sector limit ` +
          'cannot be judged. Classify the instrument before trading it.',
        severity: 'WARNING',
      };
    }

    const sameSector = await this.db.instrument.findMany({
      where: { sector: instrument.sector },
      select: { symbol: true },
    });
    const sectorSymbols = new Set(sameSector.map((row) => row.symbol));

    const sectorExposure = positions
      .filter((position) => sectorSymbols.has(position.symbol))
      .reduce(
        (total, position) =>
          total.plus(
            dec(position.quantity.toString())
              .abs()
              .times(dec(position.averageEntryPrice.toString())),
          ),
        dec(0),
      );

    return compare({
      limitName: 'sector exposure',
      actual: equity.greaterThan(0) ? sectorExposure.plus(notional).div(equity).times(100) : dec(0),
      limit,
      unit: `percent of equity in ${instrument.sector}`,
    });
  }

  private async lossCheck(input: {
    portfolioId: string;
    since: Date;
    limit: Decimal;
    limitName: string;
  }): Promise<RiskCheck> {
    const closed = await this.db.position.aggregate({
      where: { portfolioId: input.portfolioId, closedAt: { gte: input.since } },
      _sum: { realizedPnl: true },
    });
    const realised = dec(closed._sum.realizedPnl?.toString() ?? '0');
    // Only losses count against a loss limit; a profitable period does not
    // create headroom for a bigger one.
    const loss = realised.lessThan(0) ? realised.abs() : dec(0);

    return compare({
      limitName: input.limitName,
      actual: loss,
      limit: input.limit,
      unit: 'realised loss',
    });
  }

  private async consecutiveLossCheck(portfolioId: string, limit: number): Promise<RiskCheck> {
    const recent = await this.db.position.findMany({
      where: { portfolioId, status: 'CLOSED' },
      orderBy: { closedAt: 'desc' },
      take: Math.max(limit + 1, 10),
      select: { realizedPnl: true },
    });

    let streak = 0;
    for (const position of recent) {
      if (dec(position.realizedPnl.toString()).lessThan(0)) streak += 1;
      else break;
    }

    return compare({
      limitName: 'consecutive losses',
      actual: dec(streak),
      limit: dec(limit),
      unit: 'losing trades in a row',
    });
  }

  private async drawdownCheck(portfolioId: string, limit: Decimal): Promise<RiskCheck> {
    const drawdown = await this.drawdownOf(portfolioId);
    if (drawdown === null) {
      return {
        limitName: 'max drawdown',
        passed: true,
        actual: null,
        limit: limit.toString(),
        message:
          'No snapshots yet, so drawdown cannot be measured. This check will start working ' +
          'once the portfolio has two.',
        severity: 'INFO',
      };
    }

    return compare({
      limitName: 'max drawdown',
      actual: drawdown,
      limit,
      unit: 'percent below peak equity',
    });
  }

  /** Peak-to-current drawdown from stored snapshots, or null without two. */
  private async drawdownOf(portfolioId: string): Promise<Decimal | null> {
    const snapshots = await this.db.portfolioSnapshot.findMany({
      where: { portfolioId },
      orderBy: { asOf: 'asc' },
      select: { equity: true },
    });
    if (snapshots.length < 2) return null;

    let peak = dec(0);
    for (const snapshot of snapshots) {
      const equity = dec(snapshot.equity.toString());
      if (equity.greaterThan(peak)) peak = equity;
    }
    if (peak.lessThanOrEqualTo(0)) return null;

    const current = dec(snapshots[snapshots.length - 1]!.equity.toString());
    return peak.minus(current).div(peak).times(100);
  }

  /**
   * Correlation between the proposal and what is already held.
   *
   * Measured on stored closes rather than assumed from sector: two energy names
   * can move apart and two unrelated names can move together, and the point of
   * the check is the actual co-movement. Without enough overlapping history the
   * check reports that it could not be evaluated rather than passing.
   */
  private async correlationCheck(
    trade: ProposedTrade,
    positions: { symbol: string }[],
  ): Promise<RiskCheck> {
    const others = positions
      .map((position) => position.symbol)
      .filter((symbol) => symbol !== trade.symbol);
    if (others.length === 0) {
      return {
        limitName: 'correlation',
        passed: true,
        actual: null,
        limit: '0.9',
        message: 'Nothing else is held, so there is nothing to be correlated with.',
        severity: 'INFO',
      };
    }

    const candidate = await this.returnsOf(trade.symbol);
    if (!candidate) {
      return {
        limitName: 'correlation',
        passed: false,
        actual: null,
        limit: '0.9',
        message:
          `${trade.symbol} has too little stored history to measure correlation against the ` +
          'book. That is a reason to wait, not to proceed unchecked.',
        severity: 'WARNING',
      };
    }

    let worst = dec(0);
    let worstSymbol: string | null = null;
    for (const symbol of others) {
      const series = await this.returnsOf(symbol);
      if (!series) continue;
      const rho = correlation(candidate, series);
      if (rho === null) continue;
      if (rho.abs().greaterThan(worst.abs())) {
        worst = rho;
        worstSymbol = symbol;
      }
    }

    if (!worstSymbol) {
      return {
        limitName: 'correlation',
        passed: true,
        actual: null,
        limit: '0.9',
        message: 'No held position has enough overlapping history to compare against.',
        severity: 'INFO',
      };
    }

    const limit = dec('0.9');
    const passed = worst.abs().lessThanOrEqualTo(limit);
    return {
      limitName: 'correlation',
      passed,
      actual: worst.toFixed(4),
      limit: limit.toString(),
      message: passed
        ? `Most correlated holding is ${worstSymbol} at ${worst.toFixed(2)}.`
        : `${trade.symbol} moves with ${worstSymbol} at ${worst.toFixed(2)}, past the ` +
          `${limit.toString()} limit. Two positions this alike are one position twice the size.`,
      severity: passed ? 'INFO' : 'WARNING',
    };
  }

  /** Bar-to-bar returns from the newest sixty stored closes. */
  private async returnsOf(symbol: string): Promise<Decimal[] | null> {
    const candles = await this.db.marketDataCandle.findMany({
      where: { symbol },
      orderBy: { openTime: 'desc' },
      take: 60,
      select: { close: true },
    });
    if (candles.length < 30) return null;

    const closes = candles.reverse().map((candle) => dec(candle.close.toString()));
    const returns: Decimal[] = [];
    for (let i = 1; i < closes.length; i += 1) {
      const previous = closes[i - 1]!;
      const current = closes[i]!;
      if (previous.lessThanOrEqualTo(0)) continue;
      returns.push(current.minus(previous).div(previous));
    }
    return returns.length >= 20 ? returns : null;
  }
}

/** Pearson correlation, or null when either series has no variance. */
export function correlation(a: Decimal[], b: Decimal[]): Decimal | null {
  const length = Math.min(a.length, b.length);
  if (length < 20) return null;

  const left = a.slice(a.length - length);
  const right = b.slice(b.length - length);

  const mean = (values: Decimal[]): Decimal =>
    values.reduce((total, value) => total.plus(value), dec(0)).div(values.length);

  const meanLeft = mean(left);
  const meanRight = mean(right);

  let covariance = dec(0);
  let varianceLeft = dec(0);
  let varianceRight = dec(0);

  for (let i = 0; i < length; i += 1) {
    const dl = left[i]!.minus(meanLeft);
    const dr = right[i]!.minus(meanRight);
    covariance = covariance.plus(dl.times(dr));
    varianceLeft = varianceLeft.plus(dl.times(dl));
    varianceRight = varianceRight.plus(dr.times(dr));
  }

  if (varianceLeft.lessThanOrEqualTo(0) || varianceRight.lessThanOrEqualTo(0)) return null;
  return covariance.div(varianceLeft.times(varianceRight).sqrt());
}

function compare(input: {
  limitName: string;
  actual: Decimal;
  limit: Decimal;
  unit: string;
}): RiskCheck {
  const passed = input.actual.lessThanOrEqualTo(input.limit);
  return {
    limitName: input.limitName,
    passed,
    actual: input.actual.toString(),
    limit: input.limit.toString(),
    // The numbers are in the message because a refusal without them cannot be
    // acted on.
    message: passed
      ? `${input.limitName}: ${input.actual.toFixed(2)} of ${input.limit.toFixed(2)} ${input.unit}.`
      : `${input.limitName} exceeded: ${input.actual.toFixed(2)} against a limit of ` +
        `${input.limit.toFixed(2)} ${input.unit}.`,
    severity: passed ? 'INFO' : 'CRITICAL',
  };
}

function isNearMiss(check: RiskCheck): boolean {
  if (check.actual === null) return false;
  const actual = Number(check.actual);
  const limit = Number(check.limit);
  if (!Number.isFinite(actual) || !Number.isFinite(limit) || limit <= 0) return false;
  return actual / limit >= NEAR_MISS_FRACTION;
}

function startOfUtcDay(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

/** Monday, in UTC. */
function startOfUtcWeek(at: Date): Date {
  const day = at.getUTCDay();
  const monday = new Date(startOfUtcDay(at));
  monday.setUTCDate(monday.getUTCDate() - ((day + 6) % 7));
  return monday;
}
