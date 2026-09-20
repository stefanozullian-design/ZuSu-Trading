import { describe, expect, it } from 'vitest';
import { UNCLASSIFIED, composition, type Holding } from './composition.js';
import { dec } from './money.js';
import { RISK_PROFILES } from './objectives.js';

/**
 * Composition arithmetic.
 *
 * The property worth defending above all others is the refusal: a portfolio
 * with one unpriced holding reports no percentages at all. Every alternative —
 * treating the gap as zero, or dividing by the part that is known — overstates
 * every other holding's weight, and does it silently.
 */

const profile = RISK_PROFILES.GROWTH;

function holding(
  symbol: string,
  value: number | null,
  sector: string | null = 'Technology',
): Holding {
  return {
    symbol,
    sector,
    marketValue: value === null ? null : dec(value),
    costBasis: dec(value ?? 0),
  };
}

describe('weights', () => {
  it('measures a holding against equity, cash included', () => {
    const c = composition({
      cash: dec(5_000),
      holdings: [holding('AAPL', 3_000), holding('MSFT', 2_000)],
      profile,
    });

    expect(c.equity?.toString()).toBe('10000');
    expect(c.invested?.toString()).toBe('5000');
    // 3,000 of a 10,000 portfolio, not 60% of what happens to be invested.
    expect(c.bySymbol[0]?.pct?.toString()).toBe('30');
    expect(c.cashPct?.toString()).toBe('50');
  });

  it('orders holdings largest first, whatever order they arrived in', () => {
    const c = composition({
      cash: dec(0),
      holdings: [holding('SMALL', 100), holding('BIG', 900), holding('MID', 500)],
      profile,
    });
    expect(c.bySymbol.map((w) => w.key)).toEqual(['BIG', 'MID', 'SMALL']);
  });

  it('groups by sector and names the ones nobody filled in', () => {
    const c = composition({
      cash: dec(0),
      holdings: [
        holding('AAPL', 400, 'Technology'),
        holding('MSFT', 400, 'Technology'),
        holding('XOM', 200, null),
      ],
      profile,
    });

    expect(c.bySector[0]).toMatchObject({ key: 'Technology' });
    expect(c.bySector[0]?.value.toString()).toBe('800');
    // Named rather than dropped: 20% of this portfolio is not missing, it is
    // merely unclassified, and dropping it would make the sectors sum to 80%.
    expect(c.bySector[1]?.key).toBe(UNCLASSIFIED);
  });
});

describe('an unpriced holding', () => {
  const c = composition({
    cash: dec(1_000),
    holdings: [holding('AAPL', 9_000), holding('CRDO', null)],
    profile,
  });

  it('withholds every percentage rather than computing one that is wrong', () => {
    // With CRDO dropped, AAPL would read as 90% of a 10,000 portfolio. If CRDO
    // is worth 10,000 the real answer is 45%. Both cannot be shown, and the
    // wrong one is the one that looks fine.
    expect(c.equity).toBeNull();
    expect(c.invested).toBeNull();
    expect(c.bySymbol[0]?.pct).toBeNull();
    expect(c.cashPct).toBeNull();
    expect(c.concentration.topThreePct).toBeNull();
  });

  it('says which holding it was, and reports nothing else', () => {
    expect(c.unpriced).toEqual(['CRDO']);
    expect(c.findings).toHaveLength(1);
    expect(c.findings[0]?.code).toBe('UNPRICED_HOLDINGS');
    // No concentration breach is raised, because no weight is known. A breach
    // computed from a number that is withheld would be a guess with a siren.
    expect(c.findings.map((f) => f.code)).not.toContain('SYMBOL_CONCENTRATION');
  });
});

describe('concentration', () => {
  it('reports what the weights mean, not what the count says', () => {
    const c = composition({
      cash: dec(0),
      holdings: [
        holding('BIG', 7_000),
        holding('A', 1_000),
        holding('B', 1_000),
        holding('C', 1_000),
      ],
      profile,
    });

    // Four holdings, and it behaves like about two.
    expect(Number(c.concentration.effectiveNames?.toString())).toBeCloseTo(1.92, 2);
    expect(c.concentration.largest?.key).toBe('BIG');
    expect(c.findings.map((f) => f.code)).toContain('EFFECTIVE_NAMES_LOW');
  });

  it('gives one holding an effective count of exactly one', () => {
    const c = composition({ cash: dec(0), holdings: [holding('ONLY', 5_000)], profile });
    expect(c.concentration.herfindahl?.toString()).toBe('1');
    expect(c.concentration.effectiveNames?.toString()).toBe('1');
    // Not flagged as poorly spread: with one holding that is a description,
    // not a finding, and the concentration breach below already says it.
    expect(c.findings.map((f) => f.code)).not.toContain('EFFECTIVE_NAMES_LOW');
  });

  it('measures spread among holdings, ignoring cash', () => {
    const invested = [holding('A', 500), holding('B', 500)];
    const poor = composition({ cash: dec(0), holdings: invested, profile });
    const cashHeavy = composition({ cash: dec(99_000), holdings: invested, profile });

    // Two equal holdings are two equal holdings whether or not there is cash
    // beside them. Cash is not a third name to be diversified across.
    expect(cashHeavy.concentration.effectiveNames?.toString()).toBe(
      poor.concentration.effectiveNames?.toString(),
    );
  });
});

describe('findings', () => {
  it('raises a breach when one name exceeds the objective’s limit', () => {
    const c = composition({
      cash: dec(0),
      holdings: [holding('AAPL', 800), holding('MSFT', 200)],
      profile,
    });

    const finding = c.findings.find((f) => f.code === 'SYMBOL_CONCENTRATION');
    expect(finding?.severity).toBe('BREACH');
    expect(finding?.subject).toBe('AAPL');
    // The limit is named, so the number is checkable rather than an opinion.
    expect(finding?.detail).toContain(String(profile.maxSymbolExposurePct));
  });

  it('raises a sector breach even when no single name breaches', () => {
    const c = composition({
      cash: dec(0),
      holdings: [
        holding('A', 100, 'Technology'),
        holding('B', 100, 'Technology'),
        holding('C', 100, 'Technology'),
        holding('D', 100, 'Technology'),
        holding('E', 600, 'Healthcare'),
      ],
      profile,
    });

    // Each technology name is 10%, under the 12% single-name limit; together
    // they are 40%, over the 25% sector limit. Holdings in one sector fall
    // together, so the count of names is not the protection it looks like.
    expect(c.findings.map((f) => f.code)).toContain('SECTOR_CONCENTRATION');
  });

  it('says so when recorded cash has gone negative', () => {
    const c = composition({ cash: dec(-500), holdings: [holding('AAPL', 1_000)], profile });
    expect(c.findings.map((f) => f.code)).toContain('CASH_NEGATIVE');
  });

  it('uses the objective’s own limits, so a retirement book is judged as one', () => {
    const holdings = [holding('AAPL', 140), holding('SPY', 860, 'Broad')];
    const daytrader = composition({ cash: dec(0), holdings, profile: RISK_PROFILES.DAY_TRADING });
    const retiree = composition({ cash: dec(0), holdings, profile: RISK_PROFILES.RETIREMENT });

    // 14% in one name: inside a day trader's 15%, outside a retirement book's.
    expect(daytrader.findings.some((f) => f.subject === 'AAPL')).toBe(false);
    expect(retiree.findings.some((f) => f.subject === 'AAPL')).toBe(true);
  });
});

describe('the empty cases', () => {
  it('handles a portfolio with nothing in it', () => {
    const c = composition({ cash: dec(0), holdings: [], profile });
    expect(c.equity?.toString()).toBe('0');
    expect(c.bySymbol).toEqual([]);
    expect(c.concentration.largest).toBeNull();
    expect(c.concentration.effectiveNames).toBeNull();
    // No division by zero, and nothing invented to fill the space.
    expect(c.findings).toEqual([]);
  });

  it('handles a portfolio that is only cash', () => {
    const c = composition({ cash: dec(25_000), holdings: [], profile });
    expect(c.cashPct?.toString()).toBe('100');
    expect(c.investedPct?.toString()).toBe('0');
    expect(c.concentration.herfindahl).toBeNull();
  });
});
