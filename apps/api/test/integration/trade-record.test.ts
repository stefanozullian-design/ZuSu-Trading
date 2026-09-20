import { UserRole } from '@zusu/shared';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { type AppContainer, buildContainer } from '../../src/container.js';
import type { Principal } from '../../src/modules/rbac/access-control.js';
import { disconnectTestDb, resetDatabase, testDb } from '../helpers/db.js';
import { createPortfolio, createUser, grantPortfolioAccess } from '../helpers/fixtures.js';

/**
 * Recording trades done somewhere else.
 *
 * These portfolios live at a real brokerage; the platform's part is to advise
 * and then to keep the book. So the properties under test are the ones a
 * brokerage statement would disagree with if they were wrong: the lot
 * arithmetic on a sale, which cash movements count as return and which do not,
 * and the refusals that stop a typo becoming a short position.
 */

const db = testDb();
let container: AppContainer;
let owner: Principal;
let portfolioId: string;

const MARCH = new Date('2026-03-02T15:00:00Z');
const APRIL = new Date('2026-04-06T15:00:00Z');
const MAY = new Date('2026-05-04T15:00:00Z');

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

function buy(overrides: Record<string, unknown> = {}) {
  return container.tradeRecords.record(owner, {
    portfolioId,
    type: 'BUY',
    symbol: 'AAPL',
    quantity: '10',
    price: '180',
    occurredAt: MARCH,
    ...overrides,
  });
}

function sell(overrides: Record<string, unknown> = {}) {
  return container.tradeRecords.record(owner, {
    portfolioId,
    type: 'SELL',
    symbol: 'AAPL',
    quantity: '10',
    price: '200',
    occurredAt: MAY,
    ...overrides,
  });
}

describe('recording a buy', () => {
  it('opens the position and takes the money out of recorded cash', async () => {
    const recorded = await buy({ fees: '4.95' });

    const position = await db.position.findFirstOrThrow({ where: { portfolioId } });
    expect(position.symbol).toBe('AAPL');
    expect(position.quantity.toString()).toBe('10');
    expect(position.averageEntryPrice.toString()).toBe('180');
    expect(position.openedAt.toISOString()).toBe(MARCH.toISOString());

    // 10 × 180, plus the commission.
    expect(recorded.cashDelta).toBe('-1804.95');
    const portfolio = await db.portfolio.findUniqueOrThrow({ where: { id: portfolioId } });
    expect(portfolio.cashBalance.toString()).toBe('48195.05');
  });

  it('opens a tax lot with no fill id, rather than inventing an order', async () => {
    await buy();

    const lot = await db.positionLot.findFirstOrThrow({ where: {} });
    expect(lot.costBasis.toString()).toBe('1800');
    expect(lot.remainingQty.toString()).toBe('10');
    // Nothing here routed this trade. A synthetic order would put a fiction in
    // the order book and credit a strategy with a decision a person made.
    expect(lot.executionId).toBeNull();
    expect(await db.order.count({ where: { portfolioId } })).toBe(0);
    expect(await db.execution.count({ where: { portfolioId } })).toBe(0);
  });

  it('is not a cash flow, because nothing crossed the portfolio’s boundary', async () => {
    await buy();
    // Cash became shares. A cash-flow row would tell the return calculation
    // that somebody paid money in, and the buy would erase itself from the
    // performance it is about to produce.
    expect(await db.cashFlow.count({ where: { portfolioId } })).toBe(0);
  });

  it('records the commission where the performance report reads fees', async () => {
    await buy({ fees: '4.95' });
    const fee = await db.fee.findFirstOrThrow({ where: { portfolioId } });
    expect(fee.amount.toString()).toBe('4.95');
    expect(fee.incurredAt.toISOString()).toBe(MARCH.toISOString());
  });

  it('refuses a symbol the platform cannot price', async () => {
    await expect(buy({ symbol: 'NOPE' })).rejects.toThrow(/not an instrument this platform knows/);
  });
});

describe('recording a sale', () => {
  it('realises the gain against the lot’s own cost, oldest lot first', async () => {
    await buy({ quantity: '10', price: '180', occurredAt: MARCH });
    await buy({ quantity: '10', price: '220', occurredAt: APRIL });

    const recorded = await sell({ quantity: '10', price: '200' });

    // FIFO: the March lot at 180 is consumed, not the average of 200 — which
    // would have reported this sale as exactly break-even.
    expect(recorded.realizedPnl).toBe('200');
    const march = await db.positionLot.findFirstOrThrow({ orderBy: { openedAt: 'asc' } });
    expect(march.remainingQty.toString()).toBe('0');
    expect(march.closedAt).not.toBeNull();
  });

  it('puts the proceeds back into recorded cash, net of fees', async () => {
    await buy();
    const recorded = await sell({ fees: '4.95' });

    expect(recorded.cashDelta).toBe('1995.05');
    const portfolio = await db.portfolio.findUniqueOrThrow({ where: { id: portfolioId } });
    // 50000 − 1800 + 1995.05
    expect(portfolio.cashBalance.toString()).toBe('50195.05');
  });

  it('closes the position and keeps it, with its realised gain', async () => {
    await buy();
    const recorded = await sell();

    const position = await db.position.findUniqueOrThrow({
      where: { id: recorded.positionId as string },
    });
    expect(position.status).toBe('CLOSED');
    expect(position.realizedPnl.toString()).toBe('200');
    expect(recorded.warnings.join(' ')).toContain('closed the AAPL position');
  });

  it('refuses to sell more than the book shows, rather than opening a short', async () => {
    await buy({ quantity: '10' });

    // A routed fill may legitimately reverse into a short. Typed in by hand it
    // is a typo or a missing buy, and a short nobody arranged is a claim about
    // a borrow that does not exist.
    await expect(sell({ quantity: '25' })).rejects.toThrow(/would open a short position/);
    const position = await db.position.findFirstOrThrow({ where: { portfolioId } });
    expect(position.quantity.toString()).toBe('10');
  });

  it('refuses a sale of something that was never bought', async () => {
    await expect(sell()).rejects.toThrow(/holds no AAPL/);
  });
});

describe('cash', () => {
  it('records a dividend as income, not as money paid in', async () => {
    await buy();
    const recorded = await container.tradeRecords.record(owner, {
      portfolioId,
      type: 'DIVIDEND',
      symbol: 'AAPL',
      amount: '24.50',
      occurredAt: APRIL,
    });

    const flow = await db.cashFlow.findUniqueOrThrow({
      where: { id: recorded.cashFlowId as string },
    });
    // Its own type, and the whole reason it has one: both return measures
    // subtract deposits and withdrawals, and subtracting a dividend would
    // erase the return it represents.
    expect(flow.type).toBe('DIVIDEND');
    expect(flow.amount.toString()).toBe('24.5');
    expect(flow.reference).toBe('AAPL');
  });

  it('warns rather than refuses when the dividend’s shares are already sold', async () => {
    const recorded = await container.tradeRecords.record(owner, {
      portfolioId,
      type: 'DIVIDEND',
      symbol: 'AAPL',
      amount: '24.50',
      occurredAt: APRIL,
    });
    // An ex-date before a sale is ordinary, so this is a remark and not a
    // reason to throw away the entry.
    expect(recorded.warnings.join(' ')).toContain('holds no AAPL today');
    expect(recorded.cashFlowId).not.toBeNull();
  });

  it('stores a withdrawal signed, so a sum over the column is the net movement', async () => {
    const recorded = await container.tradeRecords.record(owner, {
      portfolioId,
      type: 'WITHDRAWAL',
      amount: '2000',
      occurredAt: APRIL,
    });

    expect(recorded.cashDelta).toBe('-2000');
    const flow = await db.cashFlow.findUniqueOrThrow({
      where: { id: recorded.cashFlowId as string },
    });
    expect(flow.amount.toString()).toBe('-2000');
    const portfolio = await db.portfolio.findUniqueOrThrow({ where: { id: portfolioId } });
    expect(portfolio.cashBalance.toString()).toBe('48000');
  });

  it('refuses a deposit that carries a symbol, because no holding produced it', async () => {
    await expect(
      container.tradeRecords.record(owner, {
        portfolioId,
        type: 'DEPOSIT',
        symbol: 'AAPL',
        amount: '1000',
        occurredAt: APRIL,
      }),
    ).rejects.toThrow(/carries no symbol/);
  });

  it('refuses a dividend expressed as shares and a price', async () => {
    await expect(
      container.tradeRecords.record(owner, {
        portfolioId,
        type: 'DIVIDEND',
        quantity: '10',
        price: '2',
        occurredAt: APRIL,
      }),
    ).rejects.toThrow(/carries no quantity/);
  });
});

describe('cash that has gone negative', () => {
  it('records the trade anyway, and says so', async () => {
    const recorded = await buy({ quantity: '1000', price: '180' });

    // The real cash is at the broker. Refusing would punish the person for the
    // order they typed things in and leave the book wrong where nothing
    // reports it.
    expect(recorded.cashBalanceAfter).toBe('-130000');
    expect(recorded.warnings.join(' ')).toMatch(/negative/);
    expect(recorded.warnings.join(' ')).toMatch(/has not been recorded/);
    const position = await db.position.findFirstOrThrow({ where: { portfolioId } });
    expect(position.quantity.toString()).toBe('1000');
  });
});

describe('the ledger of what was entered', () => {
  it('keeps the entry itself, which no later trade can overwrite', async () => {
    await buy({ quantity: '10', price: '180', occurredAt: MARCH });
    await sell({ quantity: '10', price: '200', occurredAt: MAY });

    const history = await container.tradeRecords.history(owner, portfolioId);
    expect(history.map((row) => row.type)).toEqual(['SELL', 'BUY']);
    // The position is closed and its lot consumed, so nothing about today's
    // holdings can answer what was bought in March or at what price.
    const [sold, bought] = history;
    expect(bought?.price).toBe('180');
    expect(bought?.quantity).toBe('10');
    expect(sold?.realizedPnl).toBe('200');
    expect(sold?.cashDelta).toBe('2000');
  });

  it('filters by symbol', async () => {
    await buy();
    await container.tradeRecords.record(owner, {
      portfolioId,
      type: 'DEPOSIT',
      amount: '500',
      occurredAt: APRIL,
    });

    expect(
      (await container.tradeRecords.history(owner, portfolioId, { symbol: 'aapl' })).length,
    ).toBe(1);
    expect((await container.tradeRecords.history(owner, portfolioId)).length).toBe(2);
  });

  it('is audited as its own action, naming that it was typed in', async () => {
    await buy();
    const entry = await db.auditLog.findFirstOrThrow({ where: { action: 'TRADE_RECORDED' } });
    expect(entry.actorUserId).toBe(owner.id);
    expect(JSON.stringify(entry.afterValue)).toContain('AAPL');
    expect(JSON.stringify(entry.metadata)).toContain('recordedByHand');
  });
});

describe('what a date means', () => {
  it('refuses a trade dated in the future', async () => {
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await expect(buy({ occurredAt: tomorrow })).rejects.toThrow(/in the future/);
  });

  it('uses the date it happened at the broker, not the date it was typed', async () => {
    await buy({ occurredAt: MARCH });
    const lot = await db.positionLot.findFirstOrThrow({ where: {} });
    expect(lot.openedAt.toISOString()).toBe(MARCH.toISOString());
  });
});
