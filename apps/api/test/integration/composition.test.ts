import { RISK_PROFILES, UserRole } from '@zusu/shared';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { type AppContainer, buildContainer } from '../../src/container.js';
import type { Principal } from '../../src/modules/rbac/access-control.js';
import { disconnectTestDb, resetDatabase, testDb } from '../helpers/db.js';
import { createPortfolio, createUser, grantPortfolioAccess } from '../helpers/fixtures.js';

/**
 * Composition, end to end.
 *
 * The pure arithmetic is covered in `@zusu/shared`. What is tested here is the
 * wiring the unit tests cannot see: that sectors come from the instrument
 * table rather than from the position, that an unpriced holding really does
 * withhold every percentage once a real market-data source is involved, and
 * that the limits applied are the ones this portfolio's objective implies.
 */

const db = testDb();
let container: AppContainer;
let owner: Principal;

const MARCH = new Date('2026-03-02T15:00:00Z');

/**
 * PAPER, not DEMO, throughout.
 *
 * The demo venue invents a price from a seed, so a holding bought at 100 marks
 * at whatever the simulator says and no weight in these tests would be
 * predictable. The paper venue quotes from the last stored 5-minute bar, which
 * means `priceAt` below decides every mark exactly.
 */
async function portfolioFor(objective: 'GROWTH' | 'RETIREMENT' | null) {
  const portfolio = await createPortfolio(db, {
    name: `Book ${String(Math.random())}`,
    initialCapital: '10000',
    environment: 'PAPER',
  });
  if (objective) {
    await db.portfolio.update({ where: { id: portfolio.id }, data: { objective } });
  }
  await grantPortfolioAccess(db, owner.id, portfolio.id, true);
  return portfolio.id;
}

async function instrument(symbol: string, sector: string | null) {
  await db.instrument.create({
    data: { symbol, name: symbol, exchange: 'XNYS', ...(sector ? { sector } : {}) },
  });
}

/** Stores one 5-minute bar, which is what the paper venue quotes from. */
async function priceAt(symbol: string, close: string) {
  const row = await db.instrument.findUniqueOrThrow({ where: { symbol } });
  const openTime = new Date('2026-03-02T15:00:00Z');
  await db.marketDataCandle.create({
    data: {
      instrumentId: row.id,
      symbol,
      timeframe: '5m',
      openTime,
      closeTime: new Date(openTime.getTime() + 300_000),
      open: close,
      high: close,
      low: close,
      close,
      volume: '10000',
      provider: 'test',
    },
  });
}

async function hold(portfolioId: string, symbol: string, quantity: string, price: string) {
  return container.tradeRecords.record(owner, {
    portfolioId,
    type: 'BUY',
    symbol,
    quantity,
    price,
    occurredAt: MARCH,
  });
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
});

afterAll(async () => {
  await disconnectTestDb();
});

describe('what the portfolio is made of', () => {
  it('reads the sector from the instrument, not from the position', async () => {
    const id = await portfolioFor('GROWTH');
    await instrument('AAPL', 'Technology');
    await instrument('XOM', 'Energy');
    await priceAt('AAPL', '100');
    await priceAt('XOM', '100');
    await hold(id, 'AAPL', '10', '100');
    await hold(id, 'XOM', '10', '100');

    const view = await container.composition.forPortfolio(owner, id);

    // A position row has no sector column, and inventing one on it would let
    // two portfolios disagree about what industry a company is in.
    expect(view.bySector.map((s) => s.key).sort()).toEqual(['Energy', 'Technology']);
    expect(view.holdings.find((h) => h.symbol === 'AAPL')?.sector).toBe('Technology');
  });

  it('names a holding whose instrument has no sector rather than dropping it', async () => {
    const id = await portfolioFor('GROWTH');
    await instrument('MYST', null);
    await priceAt('MYST', '100');
    await hold(id, 'MYST', '10', '100');

    const view = await container.composition.forPortfolio(owner, id);

    // Dropping it would make the sector weights sum to less than the invested
    // total, with nothing on screen to explain the gap.
    expect(view.bySector.map((s) => s.key)).toEqual(['Unclassified']);
    expect(view.findings.map((f) => f.code)).toContain('SECTOR_UNKNOWN');
  });

  it('crosses the wire as strings, never as JSON numbers', async () => {
    const id = await portfolioFor('GROWTH');
    await instrument('AAPL', 'Technology');
    await priceAt('AAPL', '100');
    await hold(id, 'AAPL', '10', '100');

    const view = await container.composition.forPortfolio(owner, id);

    expect(typeof view.cash).toBe('string');
    expect(typeof view.bySymbol[0]?.value).toBe('string');
    for (const weight of [...view.bySymbol, ...view.bySector]) {
      expect(typeof weight.value).toBe('string');
      if (weight.pct !== null) expect(typeof weight.pct).toBe('string');
    }
  });
});

describe('a holding nothing can price', () => {
  it('withholds every percentage and names the symbol', async () => {
    const id = await portfolioFor('GROWTH');
    await instrument('AAPL', 'Technology');
    await instrument('GHOST', 'Technology');
    await priceAt('AAPL', '100');
    // GHOST gets an instrument row and no bar, so the venue cannot quote it.
    await hold(id, 'AAPL', '10', '100');
    await hold(id, 'GHOST', '10', '100');

    const view = await container.composition.forPortfolio(owner, id);

    expect(view.unpriced).toEqual(['GHOST']);
    expect(view.equity).toBeNull();
    expect(view.cashPct).toBeNull();
    expect(view.bySymbol.every((w) => w.pct === null)).toBe(true);
    // And nothing else is reported, because everything else divides by an
    // equity that is not known.
    expect(view.findings.map((f) => f.code)).toEqual(['UNPRICED_HOLDINGS']);
  });
});

describe('the limits applied', () => {
  it('judges a portfolio by its own objective', async () => {
    await instrument('AAPL', 'Technology');
    await instrument('SPY', 'Broad');
    await priceAt('AAPL', '100');
    await priceAt('SPY', '100');

    const growth = await portfolioFor('GROWTH');
    // 1,400 of a 10,000 portfolio: cash pays for it, so equity stays 10,000.
    await hold(growth, 'AAPL', '14', '100');
    await hold(growth, 'SPY', '86', '100');

    const view = await container.composition.forPortfolio(owner, growth);

    expect(view.equity).toBe('10000');
    expect(view.bySymbol.find((w) => w.key === 'AAPL')?.pct).toBe('14');

    // 14% in one name against a growth book's 12% limit. The finding names the
    // limit, so the number can be checked rather than taken on trust.
    const finding = view.findings.find((f) => f.subject === 'AAPL');
    expect(finding?.code).toBe('SYMBOL_CONCENTRATION');
    expect(finding?.detail).toContain(String(RISK_PROFILES.GROWTH.maxSymbolExposurePct));
  });

  it('flags the same holdings against a stricter objective and not a looser one', async () => {
    await instrument('AAPL', 'Technology');
    await instrument('SPY', 'Broad');
    await priceAt('AAPL', '100');
    await priceAt('SPY', '100');

    const daytrading = await portfolioFor(null);
    await hold(daytrading, 'AAPL', '14', '100');
    await hold(daytrading, 'SPY', '86', '100');
    const retirement = await portfolioFor('RETIREMENT');
    await hold(retirement, 'AAPL', '14', '100');
    await hold(retirement, 'SPY', '86', '100');

    const loose = await container.composition.forPortfolio(owner, daytrading);
    const strict = await container.composition.forPortfolio(owner, retirement);

    // Identical holdings, different verdicts. That is the point of recording
    // what the money is for: 14% in one name is inside a day trader's appetite
    // and outside a retirement book's.
    expect(loose.findings.some((f) => f.subject === 'AAPL')).toBe(false);
    expect(strict.findings.some((f) => f.subject === 'AAPL')).toBe(true);
  });

  it('is readable by anyone who can see positions', async () => {
    const id = await portfolioFor('GROWTH');
    const viewer = await createUser(db, { email: 'viewer@zusu.local', role: UserRole.VIEWER });
    await grantPortfolioAccess(db, viewer.id, id, false);

    const asViewer: Principal = {
      id: viewer.id,
      role: viewer.role,
      clientId: viewer.clientId,
      email: viewer.email,
      isActive: viewer.isActive,
    };

    // Reading what a portfolio is made of is reading, and a viewer who can see
    // the positions can already compute this by hand.
    await expect(container.composition.forPortfolio(asViewer, id)).resolves.toBeTruthy();
  });
});
