import { describe, expect, it } from 'vitest';
import { combine } from './combine';
import type { PortfolioSummary } from '@/lib/types';

/**
 * Adding portfolios up.
 *
 * Every test here is about a total that would be *wrong in the reassuring
 * direction* if the obvious implementation were used: a sum that quietly skips
 * what it could not read, a percentage averaged across books where it has no
 * meaning, or two currencies added as though they were one.
 */

function portfolio(overrides: Partial<PortfolioSummary> = {}): PortfolioSummary {
  return {
    id: crypto.randomUUID(),
    name: 'A book',
    environment: 'DEMO',
    clientId: null,
    clientName: null,
    objective: null,
    baseCurrency: 'USD',
    executionMode: 'MANUAL_APPROVAL',
    tradingState: 'ACTIVE',
    isActive: true,
    cashBalance: '1000.00',
    positionsValue: '500.00',
    equity: '1500.00',
    initialCapital: '1000.00',
    dailyPnl: '10.00',
    dailyPnlPct: '0.01',
    openPositions: 1,
    dailyRiskUsedPct: '50',
    killSwitchEngaged: false,
    ...overrides,
  };
}

describe('combining', () => {
  it('adds the money and counts the positions', () => {
    const total = combine([
      portfolio({ cashBalance: '1000.00', equity: '1500.00', openPositions: 2 }),
      portfolio({ cashBalance: '2500.50', equity: '4000.25', openPositions: 3 }),
    ]);

    expect(total.cashBalance).toBe('3500.50000000');
    expect(total.equity).toBe('5500.25000000');
    expect(total.openPositions).toBe(5);
    expect(total.baseCurrency).toBe('USD');
    expect(total.caveats).toEqual([]);
  });

  it('keeps the arithmetic exact rather than going through a float', () => {
    const total = combine([
      portfolio({ cashBalance: '0.10', equity: '0.10' }),
      portfolio({ cashBalance: '0.20', equity: '0.20' }),
    ]);

    // 0.1 + 0.2 is 0.30000000000000004 in floating point. Money does not do
    // that here, and a dashboard that showed it would be a tell that it might.
    expect(total.cashBalance).toBe('0.30000000');
  });

  it('adds a loss as a loss', () => {
    const total = combine([portfolio({ dailyPnl: '-250.75' }), portfolio({ dailyPnl: '100.25' })]);

    expect(total.dailyPnl).toBe('-150.50000000');
  });

  it('reports no total at all when one part is unknown', () => {
    const total = combine([portfolio({ equity: '1500.00' }), portfolio({ equity: null })]);

    // The sum of the rest is not the total. It is a smaller number wearing the
    // total's label, and it is wrong in the reassuring direction.
    expect(total.equity).toBeNull();
    expect(total.caveats.join(' ')).toContain('could not mark');
  });

  it('says why a day has no combined figure', () => {
    const total = combine([portfolio({ dailyPnl: '10.00' }), portfolio({ dailyPnl: null })]);

    expect(total.dailyPnl).toBeNull();
    expect(total.caveats.join(' ')).toContain('no earlier snapshot');
  });

  it('refuses to add different currencies', () => {
    const total = combine([
      portfolio({ baseCurrency: 'USD', cashBalance: '100.00' }),
      portfolio({ baseCurrency: 'EUR', cashBalance: '100.00' }),
    ]);

    // Nothing here converts between currencies, and 200 of neither is not a
    // number anybody should be shown.
    expect(total.baseCurrency).toBeNull();
    expect(total.cashBalance).toBeNull();
    expect(total.equity).toBeNull();
    expect(total.caveats.join(' ')).toContain('USD and EUR');
    expect(total.caveats.join(' ')).toContain('not added up');
  });

  it('offers no combined risk figure, because there is not one', () => {
    const total = combine([
      portfolio({ dailyRiskUsedPct: '50' }),
      portfolio({ dailyRiskUsedPct: '50' }),
    ]);

    // Daily risk used is a percentage of *that* portfolio's loss limit. Two at
    // 50% are not one at 100%, or at 50%, or at any number: the quantity does
    // not exist across books, so the shape has no field for it.
    expect('dailyRiskUsedPct' in total).toBe(false);
  });

  it('handles a single portfolio as itself', () => {
    const only = portfolio({ cashBalance: '1234.56', equity: '2000.00' });
    const total = combine([only]);

    expect(total.cashBalance).toBe('1234.56000000');
    expect(total.count).toBe(1);
  });
});
