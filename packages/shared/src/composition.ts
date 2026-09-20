import { Decimal, dec } from './money.js';
import type { RiskProfile } from './objectives.js';

/**
 * What a portfolio is actually made of, and what is wrong with it.
 *
 * This is the arithmetic behind the dashboard and, later, behind the watcher
 * that runs on a schedule — deliberately one implementation, because a
 * concentration the screen calls fine and the alert calls a breach is worse
 * than having neither.
 *
 * It is pure: holdings and limits in, weights and findings out. No database,
 * no clock, no network. That is what makes the edge cases testable, and the
 * edge cases are where this kind of code is usually wrong — an empty
 * portfolio, a portfolio that is all cash, a single holding worth 100%, a
 * sector nobody filled in.
 *
 * **The rule that shapes everything here: a weight computed from a partial
 * valuation is not a weight.** If any holding cannot be priced, the percentages
 * would all be computed against an equity that is missing a piece, and every
 * one of them would be overstated. The answer is `null` and a list of what
 * could not be priced — never a number that looks authoritative and is not.
 */

export type FindingSeverity = 'INFO' | 'WATCH' | 'BREACH';

export interface Finding {
  /** Stable across runs, so the watcher can tell a new finding from a repeat. */
  code: string;
  severity: FindingSeverity;
  /** What is true, in one line. */
  title: string;
  /** Why it matters, and what the limit was. */
  detail: string;
  /** The symbol or sector it is about, when it is about one. */
  subject?: string;
}

export interface Holding {
  symbol: string;
  sector: string | null;
  /** Null when nothing could price it. */
  marketValue: Decimal | null;
  costBasis: Decimal;
}

export interface Weight {
  key: string;
  value: Decimal;
  /** Percent of equity, to two places. Null when the total is unknown. */
  pct: Decimal | null;
}

export interface Composition {
  /** Cash plus every holding's market value. Null if anything is unpriced. */
  equity: Decimal | null;
  cash: Decimal;
  invested: Decimal | null;
  cashPct: Decimal | null;
  investedPct: Decimal | null;
  bySymbol: Weight[];
  bySector: Weight[];
  /** Symbols nothing could price. Percentages are withheld while non-empty. */
  unpriced: string[];
  concentration: {
    largest: Weight | null;
    topThreePct: Decimal | null;
    /**
     * Herfindahl index over holding weights, 0–1. One holding gives 1.
     */
    herfindahl: Decimal | null;
    /**
     * 1 / Herfindahl: the number of equally sized holdings this portfolio
     * behaves like. Six names with one of them at 70% is not six names, and
     * this is the number that says so.
     */
    effectiveNames: Decimal | null;
  };
  findings: Finding[];
}

/** A sector nobody recorded. Named rather than dropped. */
export const UNCLASSIFIED = 'Unclassified';

export function composition(input: {
  cash: Decimal;
  holdings: Holding[];
  profile: RiskProfile;
}): Composition {
  const { cash, holdings, profile } = input;

  const unpriced = holdings
    .filter((h) => h.marketValue === null)
    .map((h) => h.symbol)
    .sort();
  const priced = holdings.filter(
    (h): h is Holding & { marketValue: Decimal } => h.marketValue !== null,
  );

  const invested =
    unpriced.length > 0 ? null : priced.reduce((s, h) => s.plus(h.marketValue), dec(0));
  const equity = invested === null ? null : cash.plus(invested);

  // Weights are against equity, including cash: a portfolio that is 90% cash
  // does not have a 100% position in its one holding, and saying so would
  // raise a breach on a portfolio that is barely invested.
  const usable = equity !== null && equity.greaterThan(0) ? equity : null;
  const pctOf = (value: Decimal): Decimal | null =>
    usable === null ? null : value.div(usable).times(100).toDecimalPlaces(2);

  const bySymbol: Weight[] = priced
    .map((h) => ({ key: h.symbol, value: h.marketValue, pct: pctOf(h.marketValue) }))
    .sort((a, b) => b.value.comparedTo(a.value));

  const sectorTotals = new Map<string, Decimal>();
  for (const h of priced) {
    const key = h.sector?.trim() || UNCLASSIFIED;
    sectorTotals.set(key, (sectorTotals.get(key) ?? dec(0)).plus(h.marketValue));
  }
  const bySector: Weight[] = [...sectorTotals.entries()]
    .map(([key, value]) => ({ key, value, pct: pctOf(value) }))
    .sort((a, b) => b.value.comparedTo(a.value));

  // Concentration is measured among the holdings, not against equity: it
  // answers "how spread out is what is invested", and cash is not a holding.
  const investedOnly = invested === null || invested.lessThanOrEqualTo(0) ? null : invested;
  const shares = investedOnly === null ? [] : priced.map((h) => h.marketValue.div(investedOnly));
  const herfindahl =
    shares.length === 0 ? null : shares.reduce((s, w) => s.plus(w.times(w)), dec(0));
  const effectiveNames =
    herfindahl === null || herfindahl.isZero() ? null : dec(1).div(herfindahl).toDecimalPlaces(2);

  const topThree = bySymbol.slice(0, 3).reduce((s, w) => s.plus(w.value), dec(0));

  const result: Composition = {
    equity,
    cash,
    invested,
    cashPct: pctOf(cash),
    investedPct: invested === null ? null : pctOf(invested),
    bySymbol,
    bySector,
    unpriced,
    concentration: {
      largest: bySymbol[0] ?? null,
      topThreePct: bySymbol.length === 0 ? null : pctOf(topThree),
      herfindahl: herfindahl === null ? null : herfindahl.toDecimalPlaces(4),
      effectiveNames,
    },
    findings: [],
  };

  result.findings = findingsFor(result, holdings.length, profile);
  return result;
}

function findingsFor(c: Composition, holdingCount: number, profile: RiskProfile): Finding[] {
  const findings: Finding[] = [];

  if (c.cash.isNegative()) {
    findings.push({
      code: 'CASH_NEGATIVE',
      severity: 'WATCH',
      title: `Recorded cash is ${c.cash.toFixed(2)}`,
      detail:
        'The real cash is at your broker; this balance only knows what has been entered. It ' +
        'usually means a deposit or a sale has not been recorded yet.',
    });
  }

  if (c.unpriced.length > 0) {
    findings.push({
      code: 'UNPRICED_HOLDINGS',
      severity: 'WATCH',
      title: `${String(c.unpriced.length)} holding${c.unpriced.length === 1 ? '' : 's'} cannot be priced`,
      detail:
        `No market data for ${c.unpriced.join(', ')}. Every percentage on this page is ` +
        'withheld while that is true, because a weight computed against an incomplete ' +
        'valuation is overstated for every other holding.',
      subject: c.unpriced[0] as string,
    });
    // Everything below divides by equity, and there is no trustworthy equity.
    return findings;
  }

  for (const weight of c.bySymbol) {
    if (weight.pct === null) continue;
    if (weight.pct.greaterThan(profile.maxSymbolExposurePct)) {
      findings.push({
        code: 'SYMBOL_CONCENTRATION',
        severity: 'BREACH',
        title: `${weight.key} is ${weight.pct.toFixed(1)}% of the portfolio`,
        detail:
          `This objective's limit for a single name is ${String(profile.maxSymbolExposurePct)}%. ` +
          'A position this size decides the portfolio’s result on its own.',
        subject: weight.key,
      });
    }
  }

  for (const weight of c.bySector) {
    if (weight.pct === null) continue;
    if (weight.key === UNCLASSIFIED) {
      findings.push({
        code: 'SECTOR_UNKNOWN',
        severity: 'INFO',
        title: `${weight.pct.toFixed(1)}% sits in holdings with no sector recorded`,
        detail:
          'Sector concentration cannot be checked for those. The data provider did not supply ' +
          'a sector when the symbol was added.',
        subject: weight.key,
      });
      continue;
    }
    if (weight.pct.greaterThan(profile.maxSectorExposurePct)) {
      findings.push({
        code: 'SECTOR_CONCENTRATION',
        severity: 'BREACH',
        title: `${weight.key} is ${weight.pct.toFixed(1)}% of the portfolio`,
        detail:
          `This objective's limit for one sector is ${String(profile.maxSectorExposurePct)}%. ` +
          'Holdings in one sector fall together, so several names here are closer to one bet ' +
          'than the count suggests.',
        subject: weight.key,
      });
    }
  }

  const names = c.concentration.effectiveNames;
  if (names !== null && holdingCount >= 2 && names.lessThan(2)) {
    findings.push({
      code: 'EFFECTIVE_NAMES_LOW',
      severity: 'WATCH',
      title: `${String(holdingCount)} holdings that behave like ${names.toFixed(1)}`,
      detail:
        'One position dominates the others by size. The count of holdings is not the ' +
        'diversification — the weights are.',
    });
  }

  if (holdingCount > profile.maxOpenPositions) {
    findings.push({
      code: 'TOO_MANY_POSITIONS',
      severity: 'WATCH',
      title: `${String(holdingCount)} open positions`,
      detail:
        `This objective expects at most ${String(profile.maxOpenPositions)}. More positions ` +
        'than can be followed is its own risk.',
    });
  }

  if (c.investedPct !== null && c.investedPct.greaterThan(profile.maxPortfolioExposurePct)) {
    findings.push({
      code: 'EXPOSURE_HIGH',
      severity: 'WATCH',
      title: `${c.investedPct.toFixed(1)}% of the portfolio is invested`,
      detail:
        `This objective expects at most ${String(profile.maxPortfolioExposurePct)}% in the ` +
        'market, leaving the rest as cash to act with.',
    });
  }

  return findings;
}
