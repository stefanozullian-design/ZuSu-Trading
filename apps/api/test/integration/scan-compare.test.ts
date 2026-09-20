import { UserRole } from '@zusu/shared';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { type AppContainer, buildContainer } from '../../src/container.js';
import type { Principal } from '../../src/modules/rbac/access-control.js';
import { disconnectTestDb, resetDatabase, testDb } from '../helpers/db.js';
import { createPortfolio, createUser, grantPortfolioAccess } from '../helpers/fixtures.js';

/**
 * Comparing saved scans.
 *
 * The view exists for one number — how many independent filters flagged a
 * symbol — so the tests are about that number being right, being sorted on,
 * and never being dressed up as a verdict. The rest is about refusing to let
 * one broken scan hide everything the working ones found.
 */

const db = testDb();
let container: AppContainer;
let owner: Principal;

const START = Date.UTC(2026, 2, 2, 14, 30);

async function instrument(symbol: string, sector: string | null) {
  return db.instrument.create({
    data: { symbol, name: symbol, exchange: 'XNYS', ...(sector ? { sector } : {}) },
  });
}

/** A flat series at `close`, long enough for a 50-period average to warm up. */
async function series(symbol: string, close: number) {
  const row = await db.instrument.findUniqueOrThrow({ where: { symbol } });
  const rows = Array.from({ length: 80 }, (_, i) => {
    const openTime = new Date(START + i * 300_000);
    return {
      instrumentId: row.id,
      symbol,
      timeframe: '5m',
      openTime,
      closeTime: new Date(openTime.getTime() + 300_000),
      open: String(close),
      high: String(close),
      low: String(close),
      close: String(close),
      volume: '10000',
      provider: 'test',
    };
  });
  await db.marketDataCandle.createMany({ data: rows });
}

async function scan(name: string, conditions: unknown[]) {
  const created = await container.scans.create({
    name,
    timeframe: '5m',
    conditions: conditions as never,
  });
  return created.id;
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

describe('agreement', () => {
  it('counts the methods that flagged each symbol, and sorts by it', async () => {
    await instrument('BOTH', 'Technology');
    await instrument('ONE', 'Energy');
    await series('BOTH', 50);
    await series('ONE', 150);

    // Two filters that both catch BOTH, only one of which catches ONE.
    const cheap = await scan('Under 100', [
      { field: 'close', operator: 'lt', operand: { constant: '100' } },
    ]);
    const anything = await scan('Anything priced', [
      { field: 'close', operator: 'gt', operand: { constant: '1' } },
    ]);

    const result = await container.scanCompare.compare(owner, { scanIds: [cheap, anything] });

    // The whole point of the view: the corroborated name is first.
    expect(result.rows[0]?.symbol).toBe('BOTH');
    expect(result.rows[0]?.agreement).toBe(2);
    expect(result.rows[0]?.flaggedBy).toEqual([cheap, anything]);
    expect(result.rows[1]?.symbol).toBe('ONE');
    expect(result.rows[1]?.agreement).toBe(1);
  });

  it('returns a column per method even when it matched nothing', async () => {
    await instrument('AAPL', 'Technology');
    await series('AAPL', 100);

    const matches = await scan('Matches', [
      { field: 'close', operator: 'gt', operand: { constant: '1' } },
    ]);
    const nothing = await scan('Matches nothing', [
      { field: 'close', operator: 'lt', operand: { constant: '1' } },
    ]);

    const result = await container.scanCompare.compare(owner, { scanIds: [matches, nothing] });

    // A method that found nothing is a result, not an absence: the reader
    // needs to know it ran.
    expect(result.methods).toHaveLength(2);
    expect(result.methods.find((m) => m.scanId === nothing)?.matched).toBe(0);
    expect(result.methods.find((m) => m.scanId === nothing)?.error).toBeNull();
  });

  it('never presents agreement as a verdict', async () => {
    await instrument('AAPL', 'Technology');
    await series('AAPL', 100);
    const one = await scan('One', [{ field: 'close', operator: 'gt', operand: { constant: '1' } }]);

    const result = await container.scanCompare.compare(owner, { scanIds: [one] });

    // Returned with every response rather than left to be inferred: filters
    // that test the same idea agree with each other by construction.
    expect(result.caveats.join(' ')).toMatch(/not a score/i);
    expect(result.caveats.join(' ')).toMatch(/same idea|one opinion/i);
  });
});

describe('a scan that cannot run', () => {
  it('reports it in its own column and still runs the others', async () => {
    await instrument('AAPL', 'Technology');
    await series('AAPL', 100);
    const working = await scan('Working', [
      { field: 'close', operator: 'gt', operand: { constant: '1' } },
    ]);

    const missing = '11111111-1111-4111-8111-111111111111';
    const result = await container.scanCompare.compare(owner, { scanIds: [working, missing] });

    // One bad filter must not hide every result from the good ones.
    expect(result.rows.map((r) => r.symbol)).toContain('AAPL');
    const broken = result.methods.find((m) => m.scanId === missing);
    expect(broken?.error).toBeTruthy();
    expect(broken?.matched).toBe(0);
  });
});

describe('fit against a portfolio', () => {
  it('says nothing about fit when no portfolio was named', async () => {
    await instrument('AAPL', 'Technology');
    await series('AAPL', 100);
    const any = await scan('Any', [{ field: 'close', operator: 'gt', operand: { constant: '1' } }]);

    const result = await container.scanCompare.compare(owner, { scanIds: [any] });

    // Fit is a claim about a specific portfolio. With none named there is no
    // claim to make, and inventing a neutral one would read as approval.
    expect(result.portfolioId).toBeNull();
    expect(result.rows[0]?.fit).toEqual([]);
    expect(result.rows[0]?.held).toBe(false);
  });

  it('marks a candidate the portfolio already holds', async () => {
    await instrument('AAPL', 'Technology');
    await series('AAPL', 100);

    const portfolio = await createPortfolio(db, {
      name: 'Mine',
      initialCapital: '10000',
      environment: 'PAPER',
    });
    await grantPortfolioAccess(db, owner.id, portfolio.id, true);
    await container.tradeRecords.record(owner, {
      portfolioId: portfolio.id,
      type: 'BUY',
      symbol: 'AAPL',
      quantity: '10',
      price: '100',
      occurredAt: new Date(START),
    });

    const any = await scan('Any', [{ field: 'close', operator: 'gt', operand: { constant: '1' } }]);
    const result = await container.scanCompare.compare(owner, {
      scanIds: [any],
      portfolioId: portfolio.id,
    });

    const row = result.rows.find((r) => r.symbol === 'AAPL');
    expect(row?.held).toBe(true);
    expect(row?.heldPct).toBe('10');
    expect(row?.fit.map((f) => f.code)).toContain('ALREADY_HELD');
  });

  it('says a candidate would open something new when it would', async () => {
    await instrument('AAPL', 'Technology');
    await instrument('XOM', 'Energy');
    await series('AAPL', 100);
    await series('XOM', 100);

    const portfolio = await createPortfolio(db, {
      name: 'Mine',
      initialCapital: '10000',
      environment: 'PAPER',
    });
    await grantPortfolioAccess(db, owner.id, portfolio.id, true);
    await container.tradeRecords.record(owner, {
      portfolioId: portfolio.id,
      type: 'BUY',
      symbol: 'AAPL',
      quantity: '5',
      price: '100',
      occurredAt: new Date(START),
    });

    const any = await scan('Any', [{ field: 'close', operator: 'gt', operand: { constant: '1' } }]);
    const result = await container.scanCompare.compare(owner, {
      scanIds: [any],
      portfolioId: portfolio.id,
    });

    const xom = result.rows.find((r) => r.symbol === 'XOM');
    expect(xom?.held).toBe(false);
    expect(xom?.fit.map((f) => f.code)).toContain('ADDS_SOMETHING_NEW');
    // And it is a statement about fit, not a recommendation.
    expect(xom?.fit[0]?.detail).toMatch(/separate question/i);
  });
});
