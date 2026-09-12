import { UserRole, dec } from '@zusu/shared';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildContainer, type AppContainer } from '../../src/container.js';
import { MarketDataQualityService } from '../../src/modules/market-data/quality.service.js';
import type { ProviderCandle } from '../../src/modules/market-data/types.js';
import type { Principal } from '../../src/modules/rbac/access-control.js';
import { disconnectTestDb, resetDatabase, testDb } from '../helpers/db.js';
import { createPortfolio, createUser } from '../helpers/fixtures.js';

/**
 * Portfolio accounting.
 *
 * The test this module exists for is the first one: an account that doubled
 * because somebody wired money in has returned nothing, and any arithmetic
 * that says otherwise is the most common performance lie there is.
 */

const db = testDb();
let container: AppContainer;
let manager: Principal;
let portfolioId: string;

const DAY = 86_400_000;
const START = Date.UTC(2026, 0, 5);

function bars(symbol: string, price: number, at: Date): ProviderCandle[] {
  return [
    {
      symbol,
      timeframe: '5m' as const,
      openTime: at,
      closeTime: new Date(at.getTime() + 300_000),
      open: dec(price),
      high: dec(price),
      low: dec(price),
      close: dec(price),
      volume: dec(10_000),
      vwap: null,
      tradeCount: 10,
      isAdjusted: true,
    },
  ];
}

beforeEach(async () => {
  await resetDatabase();
  container ??= buildContainer({ db });

  const user = await createUser(db, { email: 'ops@test.local', role: UserRole.MANAGER });
  manager = { ...user };
  const portfolio = await createPortfolio(db, { name: 'Alpha', initialCapital: '10000' });
  portfolioId = portfolio.id;
  await db.portfolioAccess.create({
    data: { userId: user.id, portfolioId: portfolio.id, canTrade: true },
  });
});

afterAll(async () => {
  await disconnectTestDb();
});

/** Sets cash directly, standing in for trading profit or loss. */
async function setCash(amount: string): Promise<void> {
  await db.portfolio.update({ where: { id: portfolioId }, data: { cashBalance: amount } });
}

describe('a deposit is not a profit', () => {
  it('reports a deposit as a deposit and a return of nothing', async () => {
    await container.performance.writeSnapshot(portfolioId, new Date(START));

    await container.performance.recordCashFlow(manager, {
      portfolioId,
      type: 'DEPOSIT',
      amount: '10000',
      occurredAt: new Date(START + DAY),
    });
    await container.performance.writeSnapshot(portfolioId, new Date(START + DAY));

    const report = await container.performance.report(manager, portfolioId, {
      from: new Date(START),
      to: new Date(START + DAY),
    });

    // Equity doubled, and the return is zero.
    expect(report.openingEquity).toBe('10000');
    expect(report.closingEquity).toBe('20000');
    expect(report.netDeposits).toBe('10000');
    expect(report.investmentGain).toBe('0');
    expect(Number(report.timeWeightedReturnPct)).toBe(0);
  });

  it('separates a withdrawal from a loss', async () => {
    await container.performance.writeSnapshot(portfolioId, new Date(START));

    await container.performance.recordCashFlow(manager, {
      portfolioId,
      type: 'WITHDRAWAL',
      amount: '4000',
      occurredAt: new Date(START + DAY),
    });
    await container.performance.writeSnapshot(portfolioId, new Date(START + DAY));

    const report = await container.performance.report(manager, portfolioId, {
      from: new Date(START),
      to: new Date(START + DAY),
    });

    expect(report.netDeposits).toBe('-4000');
    // The account is 40% smaller and lost nothing.
    expect(report.investmentGain).toBe('0');
    expect(Number(report.timeWeightedReturnPct)).toBe(0);
  });

  it('refuses a withdrawal larger than the cash on hand', async () => {
    await expect(
      container.performance.recordCashFlow(manager, {
        portfolioId,
        type: 'WITHDRAWAL',
        amount: '999999',
      }),
    ).rejects.toThrow(/exceeds the/);
  });

  it('refuses a negative amount, because the type says the direction', async () => {
    await expect(
      container.performance.recordCashFlow(manager, {
        portfolioId,
        type: 'DEPOSIT',
        amount: '-500',
      }),
    ).rejects.toThrow(/must be positive/);
  });
});

describe('time-weighted return', () => {
  it('chains period returns and ignores when the money arrived', async () => {
    // Day 0: 10,000. Day 1: trading takes it to 11,000 (+10%). Day 2: a
    // 10,000 deposit lands and trading adds another 10% on the new base.
    await container.performance.writeSnapshot(portfolioId, new Date(START));

    await setCash('11000');
    await container.performance.writeSnapshot(portfolioId, new Date(START + DAY));

    await container.performance.recordCashFlow(manager, {
      portfolioId,
      type: 'DEPOSIT',
      amount: '10000',
      occurredAt: new Date(START + 2 * DAY),
    });
    await setCash('23100');
    await container.performance.writeSnapshot(portfolioId, new Date(START + 2 * DAY));

    const report = await container.performance.report(manager, portfolioId, {
      from: new Date(START),
      to: new Date(START + 2 * DAY),
    });

    // 1.10 × 1.10 = 1.21, so 21% — not the 131% the raw equity change implies.
    expect(Number(report.timeWeightedReturnPct)).toBeCloseTo(21, 4);
  });

  it('is null with a single snapshot rather than guessed from one point', async () => {
    await container.performance.writeSnapshot(portfolioId, new Date(START));

    const report = await container.performance.report(manager, portfolioId, {
      from: new Date(START),
      to: new Date(START + DAY),
    });

    expect(report.timeWeightedReturnPct).toBeNull();
    expect(report.notes.join(' ')).toContain('Fewer than two snapshots');
  });
});

describe('money-weighted return', () => {
  it('differs from the time-weighted figure, and both are reported', async () => {
    // Ninety days, because an internal rate of return over two days is a
    // number in the thousands of percent.
    await container.performance.writeSnapshot(portfolioId, new Date(START));
    await setCash('11000');
    await container.performance.writeSnapshot(portfolioId, new Date(START + 30 * DAY));
    await container.performance.recordCashFlow(manager, {
      portfolioId,
      type: 'DEPOSIT',
      amount: '10000',
      occurredAt: new Date(START + 60 * DAY),
    });
    await setCash('23100');
    await container.performance.writeSnapshot(portfolioId, new Date(START + 90 * DAY));

    const report = await container.performance.report(manager, portfolioId, {
      from: new Date(START),
      to: new Date(START + 90 * DAY),
    });

    expect(report.moneyWeightedReturnPct).not.toBeNull();
    // They answer different questions, so they are not the same number — and
    // the API sends both rather than choosing the flattering one.
    expect(report.moneyWeightedReturnPct).not.toBe(report.timeWeightedReturnPct);
  });

  it('is withheld for a window too short to annualise', async () => {
    await container.performance.writeSnapshot(portfolioId, new Date(START));
    await setCash('11000');
    await container.performance.writeSnapshot(portfolioId, new Date(START + DAY));

    const report = await container.performance.report(manager, portfolioId, {
      from: new Date(START),
      to: new Date(START + DAY),
    });

    // Two days compounded to a year is not a rate of return.
    expect(report.moneyWeightedReturnPct).toBeNull();
    expect(report.notes.join(' ')).toContain('shorter than a week');
  });
});

describe('snapshots', () => {
  it('marks an open position at the market and reports it separately from cash', async () => {
    await db.instrument.create({ data: { symbol: 'AAPL', name: 'Apple', exchange: 'XNYS' } });
    await new MarketDataQualityService(db).ingestCandles(bars('AAPL', 120, new Date(START)), {
      provider: 'test-feed',
    });
    await db.position.create({
      data: {
        portfolioId,
        symbol: 'AAPL',
        status: 'OPEN',
        quantity: '10',
        averageEntryPrice: '100',
        openedAt: new Date(START),
      },
    });

    const snapshot = await container.performance.writeSnapshot(portfolioId, new Date(START));

    expect(snapshot.positionsValue).toBe('1200');
    expect(snapshot.cashBalance).toBe('10000');
    expect(snapshot.equity).toBe('11200');
    // Marked at 120 against a 100 basis: 200 of unrealised gain, and it is
    // labelled unrealised rather than folded into profit.
    expect(snapshot.unrealizedPnl).toBe('200');
  });

  it('marks a position with no stored price at its own cost, not at zero', async () => {
    await db.position.create({
      data: {
        portfolioId,
        symbol: 'NOPE',
        status: 'OPEN',
        quantity: '10',
        averageEntryPrice: '50',
        openedAt: new Date(START),
      },
    });

    const snapshot = await container.performance.writeSnapshot(portfolioId, new Date(START));

    // A missing quote is not a loss.
    expect(snapshot.positionsValue).toBe('500');
    expect(snapshot.unrealizedPnl).toBe('0');
  });

  it('recomputes rather than duplicating when the same instant is written twice', async () => {
    await container.performance.writeSnapshot(portfolioId, new Date(START));
    await setCash('12345');
    const second = await container.performance.writeSnapshot(portfolioId, new Date(START));

    expect(second.equity).toBe('12345');
    expect(await db.portfolioSnapshot.count()).toBe(1);
  });

  it('reports the deepest drawdown across the snapshots it has', async () => {
    for (const [index, equity] of ['10000', '12000', '9000', '11000'].entries()) {
      await setCash(equity);
      await container.performance.writeSnapshot(portfolioId, new Date(START + index * DAY));
    }

    const report = await container.performance.report(manager, portfolioId, {
      from: new Date(START),
      to: new Date(START + 3 * DAY),
    });

    expect(Number(report.maxDrawdownPct)).toBeCloseTo(25, 6);
  });

  it('always carries the conventions it used', async () => {
    await container.performance.writeSnapshot(portfolioId, new Date(START));
    const report = await container.performance.report(manager, portfolioId, {
      from: new Date(START),
      to: new Date(START + DAY),
    });

    expect(report.notes.join(' ')).toContain('never counted as profit');
    expect(report.notes.join(' ')).toContain('arriving at the start of its period');
  });
});
