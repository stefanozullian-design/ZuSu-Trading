import type { PrismaClient } from '@prisma/client';
import {
  type Decimal,
  type Finding,
  type Holding,
  Permission,
  type Weight,
  composition,
  dec,
  riskProfileFor,
} from '@zusu/shared';
import type { BrokerRegistry } from '../broker/broker-registry.js';
import type { AccessControl, Principal } from '../rbac/access-control.js';
import { markPrices } from './marks.js';

/**
 * What a portfolio is made of.
 *
 * The dashboard's whole job, in one call: what is held, how it is spread, and
 * what about the spread is worth knowing. The arithmetic lives in
 * `@zusu/shared` and is pure; this fetches what it needs.
 *
 * Deliberately one call rather than several. The weights, the sector
 * breakdown and the findings all divide by the same equity, and a screen that
 * assembled them from three requests could render a sector percentage computed
 * against one valuation beside a holding percentage computed against another.
 *
 * The findings this returns are also what the watcher will send. One
 * implementation, because a concentration the screen calls fine and an alert
 * calls a breach is worse than having neither.
 */
export interface WeightView {
  key: string;
  value: string;
  pct: string | null;
}

export interface CompositionView {
  portfolioId: string;
  objective: string | null;
  asOf: string;
  /** Every decimal crosses the wire as a string; none of these is a JSON number. */
  equity: string | null;
  cash: string;
  invested: string | null;
  cashPct: string | null;
  investedPct: string | null;
  bySymbol: WeightView[];
  bySector: WeightView[];
  unpriced: string[];
  concentration: {
    largest: WeightView | null;
    topThreePct: string | null;
    herfindahl: string | null;
    effectiveNames: string | null;
  };
  findings: Finding[];
  holdings: {
    symbol: string;
    name: string | null;
    sector: string | null;
    quantity: string;
    averageEntryPrice: string;
    markPrice: string | null;
    marketValue: string | null;
    costBasis: string;
    unrealizedPnl: string | null;
    unrealizedPnlPct: string | null;
    pctOfEquity: string | null;
  }[];
}

export class CompositionService {
  constructor(
    private readonly db: PrismaClient,
    private readonly access: AccessControl,
    private readonly brokers: BrokerRegistry,
  ) {}

  async forPortfolio(principal: Principal, portfolioId: string): Promise<CompositionView> {
    const portfolio = await this.access.assertPortfolioAccess(principal, portfolioId, {
      permission: Permission.POSITION_READ,
    });

    const positions = await this.db.position.findMany({
      where: { portfolioId, status: 'OPEN' },
      select: { symbol: true, quantity: true, averageEntryPrice: true },
    });

    const symbols = positions.map((p) => p.symbol);
    const [marks, instruments] = await Promise.all([
      markPrices(this.brokers, portfolio, symbols),
      this.db.instrument.findMany({
        where: { symbol: { in: symbols } },
        select: { symbol: true, name: true, sector: true },
      }),
    ]);
    const bySymbol = new Map(instruments.map((i) => [i.symbol, i]));

    const holdings: Holding[] = positions.map((position) => {
      const mark = marks.get(position.symbol) ?? null;
      const quantity = dec(position.quantity.toString());
      return {
        symbol: position.symbol,
        sector: bySymbol.get(position.symbol)?.sector ?? null,
        marketValue: mark === null ? null : mark.times(quantity),
        costBasis: dec(position.averageEntryPrice.toString()).times(quantity),
      };
    });

    const cash = dec(portfolio.cashBalance.toString());
    const result = composition({
      cash,
      holdings,
      profile: riskProfileFor(portfolio.objective),
    });

    const weightOf = new Map(result.bySymbol.map((w) => [w.key, w.pct]));

    return {
      portfolioId,
      objective: portfolio.objective,
      asOf: new Date().toISOString(),
      equity: result.equity?.toString() ?? null,
      cash: cash.toString(),
      invested: result.invested?.toString() ?? null,
      cashPct: str(result.cashPct),
      investedPct: str(result.investedPct),
      bySymbol: result.bySymbol.map(weightView),
      bySector: result.bySector.map(weightView),
      unpriced: result.unpriced,
      concentration: {
        largest: result.concentration.largest ? weightView(result.concentration.largest) : null,
        topThreePct: str(result.concentration.topThreePct),
        herfindahl: str(result.concentration.herfindahl),
        effectiveNames: str(result.concentration.effectiveNames),
      },
      findings: result.findings,
      holdings: positions.map((position) => {
        const quantity = dec(position.quantity.toString());
        const entry = dec(position.averageEntryPrice.toString());
        const mark = marks.get(position.symbol) ?? null;
        const costBasis = entry.times(quantity);
        const marketValue = mark === null ? null : mark.times(quantity);
        const unrealized = marketValue === null ? null : marketValue.minus(costBasis);
        return {
          symbol: position.symbol,
          name: bySymbol.get(position.symbol)?.name ?? null,
          sector: bySymbol.get(position.symbol)?.sector ?? null,
          quantity: quantity.toString(),
          averageEntryPrice: entry.toString(),
          markPrice: mark?.toString() ?? null,
          marketValue: marketValue?.toString() ?? null,
          costBasis: costBasis.toString(),
          unrealizedPnl: unrealized?.toString() ?? null,
          // Against what was paid, which is the number a person actually asks
          // about a holding — not against the portfolio, and not against today.
          unrealizedPnlPct:
            unrealized === null || costBasis.isZero()
              ? null
              : unrealized.div(costBasis).times(100).toDecimalPlaces(2).toString(),
          pctOfEquity: weightOf.get(position.symbol)?.toString() ?? null,
        };
      }),
    };
  }
}

/** Decimals leave this module as strings, or as null. Never as JSON numbers. */
function str(value: Decimal | null): string | null {
  return value === null ? null : value.toString();
}

function weightView(weight: Weight): WeightView {
  return { key: weight.key, value: weight.value.toString(), pct: str(weight.pct) };
}
