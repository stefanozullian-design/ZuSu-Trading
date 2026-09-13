import { UserRole, dec } from '@zusu/shared';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildContainer, type AppContainer } from '../../src/container.js';
import type { Principal } from '../../src/modules/rbac/access-control.js';
import { disconnectTestDb, resetDatabase, testDb } from '../helpers/db.js';
import { createPortfolio, createUser, grantPortfolioAccess } from '../helpers/fixtures.js';

/**
 * Opening positions (§44).
 *
 * The property that matters more than any other here: **importing shares must
 * not improve anybody's track record.** Everything else — the lot, the
 * provenance mark, the untouched cash — exists so that the books stay
 * consistent once those shares are really there.
 */

const db = testDb();
let container: AppContainer;
let owner: Principal;
let portfolioId: string;

const ACQUIRED = new Date('2026-03-02T15:00:00Z');

beforeEach(async () => {
  await resetDatabase();
  container ??= buildContainer({ db });

  const portfolio = await createPortfolio(db, { name: 'Mine', initialCapital: '50000' });
  portfolioId = portfolio.id;

  const user = await createUser(db, { email: 'owner@zusu.local', role: UserRole.MANAGER });
  await grantPortfolioAccess(db, user.id, portfolioId, true);
  owner = {
    id: user.id,
    role: user.role,
    clientId: user.clientId,
    email: user.email,
    isActive: user.isActive,
  };

  await db.instrument.create({
    data: { symbol: 'AAPL', name: 'Apple', exchange: 'XNYS', sector: 'Technology' },
  });
});

afterAll(async () => {
  await disconnectTestDb();
});

function importApple(
  overrides: Partial<Parameters<typeof container.positionImport.importPosition>[1]> = {},
) {
  return container.positionImport.importPosition(owner, {
    portfolioId,
    symbol: 'AAPL',
    quantity: '50',
    averageEntryPrice: '180',
    acquiredAt: ACQUIRED,
    ...overrides,
  });
}

describe('importing shares already held', () => {
  it('records the position with its real cost basis and acquisition date', async () => {
    const imported = await importApple();

    const position = await db.position.findFirstOrThrow({ where: { portfolioId } });
    expect(position.symbol).toBe('AAPL');
    expect(position.quantity.toString()).toBe('50');
    expect(position.averageEntryPrice.toString()).toBe('180');
    expect(position.origin).toBe('IMPORTED');
    // The date it was acquired, not the date it was typed in.
    expect(position.openedAt.toISOString()).toBe(ACQUIRED.toISOString());
    expect(imported.costBasis).toBe('9000');
  });

  it('does not spend the portfolio’s cash', async () => {
    await importApple();
    // The shares arrived from elsewhere; no money left this account to buy them.
    const portfolio = await db.portfolio.findUniqueOrThrow({ where: { id: portfolioId } });
    expect(portfolio.cashBalance.toString()).toBe('50000');
  });

  it('records the arrival as a transfer in, so it is never read as a gain', async () => {
    const imported = await importApple();

    const flow = await db.cashFlow.findUniqueOrThrow({ where: { id: imported.cashFlowId } });
    expect(flow.type).toBe('TRANSFER_IN');
    // Positive, like a deposit: value came in. The return calculation
    // subtracts it for exactly the same reason it subtracts a deposit.
    expect(flow.amount.toString()).toBe('9000');
    expect(flow.occurredAt.toISOString()).toBe(ACQUIRED.toISOString());
    expect(flow.reference).toBe(imported.id);
  });

  it('opens a tax lot, so the shares can actually be sold later', async () => {
    const imported = await importApple();

    // Selling consumes lots first-in-first-out, and a position whose lots do
    // not account for its shares is a bookkeeping fault the position book
    // refuses to trade through. Without this the import would work perfectly
    // right up until the first sale.
    const lot = await db.positionLot.findFirstOrThrow({ where: { positionId: imported.id } });
    expect(lot.quantity.toString()).toBe('50');
    expect(lot.remainingQty.toString()).toBe('50');
    expect(lot.costBasis.toString()).toBe('9000');
    expect(lot.openedAt.toISOString()).toBe(ACQUIRED.toISOString());
  });

  it('creates no order and no signal, so no strategy is credited', async () => {
    await importApple();
    expect(await db.order.count({ where: { portfolioId } })).toBe(0);
    expect(await db.signal.count({ where: { portfolioId } })).toBe(0);
  });

  it('is audited as its own action', async () => {
    await importApple();
    const entry = await db.auditLog.findFirstOrThrow({ where: { action: 'POSITION_IMPORTED' } });
    expect(entry.actorUserId).toBe(owner.id);
    expect(JSON.stringify(entry.afterValue)).toContain('AAPL');
  });

  it('does not mark the position at its entry price', async () => {
    const imported = await importApple();
    // Storing the entry price as the mark would render a fresh import as
    // exactly break-even, which is a claim rather than a measurement.
    const position = await db.position.findUniqueOrThrow({ where: { id: imported.id } });
    expect(position.markPrice).toBeNull();
  });
});

describe('what it refuses', () => {
  it('refuses a second import of a symbol already held', async () => {
    await importApple();
    await expect(importApple()).rejects.toThrow(/already holds/);
  });

  it('refuses an unknown instrument rather than creating an unpriceable holding', async () => {
    await expect(importApple({ symbol: 'NOPE' })).rejects.toThrow(/not an instrument/);
  });

  it('refuses a zero or negative quantity', async () => {
    await expect(importApple({ quantity: '0' })).rejects.toThrow(/positive number of shares/);
    await expect(importApple({ quantity: '-5' })).rejects.toThrow(/positive number of shares/);
  });

  it('refuses a missing cost basis, because every later figure depends on it', async () => {
    await expect(importApple({ averageEntryPrice: '0' })).rejects.toThrow(/must be positive/);
  });

  it('refuses an acquisition date in the future', async () => {
    const tomorrow = new Date(Date.now() + 86_400_000);
    await expect(importApple({ acquiredAt: tomorrow })).rejects.toThrow(/typo, not a holding/);
  });

  it('refuses someone without trading rights on the portfolio', async () => {
    const other = await createUser(db, { email: 'nosy@zusu.local', role: UserRole.MANAGER });
    await grantPortfolioAccess(db, other.id, portfolioId, false);
    const principal: Principal = {
      id: other.id,
      role: other.role,
      clientId: other.clientId,
      email: other.email,
      isActive: other.isActive,
    };

    await expect(
      container.positionImport.importPosition(principal, {
        portfolioId,
        symbol: 'AAPL',
        quantity: '50',
        averageEntryPrice: '180',
        acquiredAt: ACQUIRED,
      }),
    ).rejects.toThrow(/trading rights/);
  });
});

describe('the returns it must not flatter', () => {
  it('counts the shares towards what you own and not towards what you earned', async () => {
    // A snapshot before the import, then one after, on the same day.
    const before = await container.performance.writeSnapshot(portfolioId, ACQUIRED);
    expect(before.equity).toBe('50000');

    await importApple();

    const after = await container.performance.writeSnapshot(
      portfolioId,
      new Date(ACQUIRED.getTime() + 3_600_000),
    );

    // Equity rose by the value of the shares — that part is simply true.
    expect(dec(after.equity).minus(dec(before.equity)).toString()).toBe('9000');

    // And the whole rise is accounted for as money that arrived rather than
    // money that was made. Time-weighted return divides by the flow, so the
    // period return is zero: nobody's record improves by remembering what
    // they already owned.
    expect(after.netCashFlow).toBe('9000');
  });

  it('leaves the time-weighted return unmoved across the import', async () => {
    await container.performance.writeSnapshot(portfolioId, ACQUIRED);
    await importApple();
    await container.performance.writeSnapshot(
      portfolioId,
      new Date(ACQUIRED.getTime() + 3_600_000),
    );

    const report = await container.performance.report(owner, portfolioId, {
      from: new Date(ACQUIRED.getTime() - 86_400_000),
      to: new Date(ACQUIRED.getTime() + 7 * 86_400_000),
    });

    // Zero, not 18%. The equity went up by 9,000 on a 50,000 book, and none
    // of it was performance.
    expect(Number(report.timeWeightedReturnPct ?? '0')).toBeCloseTo(0, 6);
  });
});

describe('reconciliation', () => {
  it('explains an imported position rather than calling it a mystery', async () => {
    await importApple();
    await db.brokerAccount.create({
      data: {
        portfolioId,
        environment: 'DEMO',
        broker: 'DEMO',
        label: 'Demo',
        connectionState: 'CONNECTED',
      },
    });

    const result = await container.reconciliation.run(portfolioId);
    const difference = result.differences.find((d) => d.symbol === 'AAPL');

    // Still reported — provenance buys a better sentence, never silence. The
    // broker genuinely may not hold what a person said they hold, and that is
    // exactly the finding reconciliation exists to surface.
    expect(difference?.kind).toBe('POSITION_MISSING_AT_BROKER');
    expect(difference?.detail).toContain('imported as already held');
    expect(difference?.detail).toContain('2026-03-02');
  });
});
