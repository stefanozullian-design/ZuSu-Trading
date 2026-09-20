import { UserRole } from '@zusu/shared';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { type AppContainer, buildContainer } from '../../src/container.js';
import type { Principal } from '../../src/modules/rbac/access-control.js';
import { disconnectTestDb, resetDatabase, testDb } from '../helpers/db.js';
import { createPortfolio, createUser, grantPortfolioAccess } from '../helpers/fixtures.js';

/**
 * The watcher.
 *
 * Almost every test here is about *not* speaking. A watcher that re-announces
 * the same concentration every hour teaches a person to skip the channel, and
 * the cost of that is the one message that was new — so the thing under test
 * is that a second run over an unchanged portfolio says nothing at all.
 */

const db = testDb();
let container: AppContainer;
let owner: Principal;
let portfolioId: string;

const START = Date.UTC(2026, 2, 2, 14, 30);

async function instrument(symbol: string, sector: string) {
  return db.instrument.create({ data: { symbol, name: symbol, exchange: 'XNYS', sector } });
}

async function priceAt(symbol: string, close: string) {
  const row = await db.instrument.findUniqueOrThrow({ where: { symbol } });
  const openTime = new Date(START);
  await db.marketDataCandle.upsert({
    where: {
      instrumentId_timeframe_openTime: { instrumentId: row.id, timeframe: '5m', openTime },
    },
    create: {
      instrumentId: row.id,
      symbol,
      timeframe: '5m',
      openTime,
      closeTime: new Date(START + 300_000),
      open: close,
      high: close,
      low: close,
      close,
      volume: '10000',
      provider: 'test',
    },
    update: { close, open: close, high: close, low: close },
  });
}

async function notifications() {
  return db.notification.findMany({ orderBy: { createdAt: 'asc' } });
}

beforeEach(async () => {
  await resetDatabase();
  container ??= buildContainer({ db });

  const user = await createUser(db, { email: 'owner@zusu.local', role: UserRole.MANAGER });
  owner = {
    id: user.id,
    role: user.role,
    clientId: user.clientId,
    email: user.email,
    isActive: user.isActive,
  };

  const portfolio = await createPortfolio(db, {
    name: 'Watched',
    initialCapital: '10000',
    environment: 'PAPER',
  });
  portfolioId = portfolio.id;
  await db.portfolio.update({ where: { id: portfolioId }, data: { objective: 'GROWTH' } });
  await grantPortfolioAccess(db, owner.id, portfolioId, true);
});

afterAll(async () => {
  await disconnectTestDb();
});

/** A holding big enough to breach the growth profile's 12% single-name limit. */
async function concentrate() {
  await instrument('AAPL', 'Technology');
  await priceAt('AAPL', '100');
  await container.tradeRecords.record(owner, {
    portfolioId,
    type: 'BUY',
    symbol: 'AAPL',
    quantity: '40',
    price: '100',
    occurredAt: new Date(START),
  });
}

describe('noticing something', () => {
  it('reports a new finding once', async () => {
    await concentrate();

    const outcome = await container.watcher.run(portfolioId);

    expect(outcome.appeared.map((f) => f.code)).toContain('SYMBOL_CONCENTRATION');
    const sent = await notifications();
    expect(sent.some((n) => n.event === 'PORTFOLIO_FINDING')).toBe(true);
    expect(sent.some((n) => n.title.includes('AAPL'))).toBe(true);
  });

  it('says nothing at all on a second run over an unchanged portfolio', async () => {
    await concentrate();
    await container.watcher.run(portfolioId);
    const after = (await notifications()).length;

    const second = await container.watcher.run(portfolioId);

    // The whole design. A person told the same thing every hour stops reading
    // any of it, which costs them the message that was new.
    expect(second.appeared).toEqual([]);
    expect(second.unchanged).toBeGreaterThan(0);
    expect((await notifications()).length).toBe(after);
  });

  it('refreshes the wording without announcing it again', async () => {
    await concentrate();
    await container.watcher.run(portfolioId);
    const before = (await notifications()).length;

    // The weight moves; the finding does not.
    await priceAt('AAPL', '110');
    await container.watcher.run(portfolioId);

    const row = await db.portfolioFinding.findFirstOrThrow({
      where: { portfolioId, code: 'SYMBOL_CONCENTRATION' },
    });
    expect(row.resolvedAt).toBeNull();
    expect((await notifications()).length).toBe(before);
  });
});

describe('something clearing', () => {
  it('says so, because a fixed problem and an unwatched one look the same otherwise', async () => {
    await concentrate();
    await container.watcher.run(portfolioId);

    // Sell most of it. The concentration is no longer true.
    await container.tradeRecords.record(owner, {
      portfolioId,
      type: 'SELL',
      symbol: 'AAPL',
      quantity: '35',
      price: '100',
      occurredAt: new Date(START + 600_000),
    });

    const outcome = await container.watcher.run(portfolioId);

    expect(outcome.cleared.map((c) => c.code)).toContain('SYMBOL_CONCENTRATION');
    const sent = await notifications();
    expect(sent.some((n) => n.event === 'PORTFOLIO_FINDING_CLEARED')).toBe(true);

    const row = await db.portfolioFinding.findFirstOrThrow({
      where: { portfolioId, code: 'SYMBOL_CONCENTRATION' },
    });
    expect(row.resolvedAt).not.toBeNull();
  });

  it('reports it again if it comes back, and restarts its clock', async () => {
    await concentrate();
    await container.watcher.run(portfolioId);
    await container.tradeRecords.record(owner, {
      portfolioId,
      type: 'SELL',
      symbol: 'AAPL',
      quantity: '35',
      price: '100',
      occurredAt: new Date(START + 600_000),
    });
    await container.watcher.run(portfolioId);

    const resolved = await db.portfolioFinding.findFirstOrThrow({
      where: { portfolioId, code: 'SYMBOL_CONCENTRATION' },
    });

    // Buy back in. Same finding, new episode.
    await container.tradeRecords.record(owner, {
      portfolioId,
      type: 'BUY',
      symbol: 'AAPL',
      quantity: '35',
      price: '100',
      occurredAt: new Date(START + 1_200_000),
    });
    const outcome = await container.watcher.run(portfolioId);

    expect(outcome.appeared.map((f) => f.code)).toContain('SYMBOL_CONCENTRATION');
    const revived = await db.portfolioFinding.findFirstOrThrow({
      where: { portfolioId, code: 'SYMBOL_CONCENTRATION' },
    });
    // One row, revived — not a second row that would make it look new forever.
    expect(
      await db.portfolioFinding.count({ where: { portfolioId, code: 'SYMBOL_CONCENTRATION' } }),
    ).toBe(1);
    expect(revived.resolvedAt).toBeNull();
    expect(revived.firstSeenAt.getTime()).toBeGreaterThan(resolved.firstSeenAt.getTime());
  });
});

describe('what it will not interrupt anyone for', () => {
  it('records an informational finding without notifying', async () => {
    await db.instrument.create({ data: { symbol: 'MYST', name: 'MYST', exchange: 'XNYS' } });
    await priceAt('MYST', '100');
    await container.tradeRecords.record(owner, {
      portfolioId,
      type: 'BUY',
      symbol: 'MYST',
      quantity: '10',
      price: '100',
      occurredAt: new Date(START),
    });

    await container.watcher.run(portfolioId);

    // "This sector is not recorded" is worth seeing when you look, and is not
    // worth interrupting anybody for. A channel that carries it will not be
    // read when something matters.
    const row = await db.portfolioFinding.findFirst({
      where: { portfolioId, code: 'SECTOR_UNKNOWN' },
    });
    expect(row).not.toBeNull();
    expect(row?.notifiedAt).toBeNull();
    expect((await notifications()).every((n) => !n.title.includes('no sector recorded'))).toBe(
      true,
    );
  });
});

describe('running unattended', () => {
  it('keeps going when one portfolio cannot be read', async () => {
    await concentrate();

    // A second portfolio in an environment with no market-data source at all.
    const broken = await createPortfolio(db, {
      name: 'Other',
      initialCapital: '1000',
      environment: 'PAPER',
    });
    await grantPortfolioAccess(db, owner.id, broken.id, true);

    const outcomes = await container.watcher.runAll();

    // A single unreadable book must not silence every other one until somebody
    // notices.
    expect(outcomes.length).toBeGreaterThanOrEqual(2);
    expect(outcomes.some((o) => o.portfolioId === portfolioId && o.error === null)).toBe(true);
  });
});
