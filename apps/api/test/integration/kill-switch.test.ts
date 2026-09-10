import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AssetClass, AuditAction, OrderType, TimeInForce, TradingState, dec } from '@zusu/shared';
import { buildTestApp, login, type Session, type TestApp } from '../helpers/app.js';
import { disconnectTestDb, resetDatabase, testDb } from '../helpers/db.js';
import { createPortfolio, createUser, grantPortfolioAccess } from '../helpers/fixtures.js';

let harness: TestApp;
const db = testDb();
let session: Session;
let portfolioId: string;
let secondPortfolioId: string;

beforeEach(async () => {
  await resetDatabase();
  harness ??= await buildTestApp();
  harness.container.brokers.reset();

  const manager = await createUser(db, { email: 'ops@test.local', role: 'MANAGER' });
  const first = await createPortfolio(db, { name: 'Alpha' });
  const second = await createPortfolio(db, { name: 'Beta' });
  portfolioId = first.id;
  secondPortfolioId = second.id;
  await grantPortfolioAccess(db, manager.id, first.id, true);
  await grantPortfolioAccess(db, manager.id, second.id, true);
  session = await login(harness.app, 'ops@test.local');
});

afterAll(async () => {
  await harness?.close();
  await disconnectTestDb();
});

describe('kill switch', () => {
  it('permits trading before it is engaged', async () => {
    const gate = await harness.app.inject({
      method: 'GET',
      url: `/api/risk/portfolios/${portfolioId}/gate`,
      headers: { cookie: session.cookies },
    });
    expect(gate.json().allowed).toBe(true);
  });

  it('halts a single portfolio and blocks the gate with a readable reason', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/risk/kill-switch',
      headers: session.headers(),
      payload: { reason: 'quote feed looks wrong', portfolioId },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().portfoliosHalted).toEqual([portfolioId]);

    const portfolio = await db.portfolio.findUniqueOrThrow({ where: { id: portfolioId } });
    expect(portfolio.tradingState).toBe(TradingState.HALTED);
    expect(portfolio.haltedReason).toBe('quote feed looks wrong');

    const gate = await harness.app.inject({
      method: 'GET',
      url: `/api/risk/portfolios/${portfolioId}/gate`,
      headers: { cookie: session.cookies },
    });
    const decision = gate.json();
    expect(decision.allowed).toBe(false);
    expect(decision.blockers[0].code).toBe('TRADING_HALTED');
    expect(decision.blockers[0].message).toContain('quote feed looks wrong');

    // The other portfolio is untouched.
    const other = await db.portfolio.findUniqueOrThrow({ where: { id: secondPortfolioId } });
    expect(other.tradingState).toBe(TradingState.ACTIVE);
  });

  it('halts every reachable portfolio when no id is given', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/risk/kill-switch',
      headers: session.headers(),
      payload: { reason: 'stop everything now' },
    });

    expect(response.json().portfoliosHalted).toHaveLength(2);
    expect(await db.portfolio.count({ where: { tradingState: TradingState.HALTED } })).toBe(2);
  });

  it('cancels resting broker orders but leaves positions alone', async () => {
    const portfolio = await db.portfolio.findUniqueOrThrow({ where: { id: portfolioId } });
    const broker = harness.container.brokers.forPortfolio(portfolio);

    // A far-away limit order that will rest rather than fill.
    const quote = await broker.getQuote('AAPL');
    await broker.placeOrder({
      idempotencyKey: 'resting-1',
      symbol: 'AAPL',
      assetClass: AssetClass.EQUITY,
      side: 'BUY',
      orderType: OrderType.LIMIT,
      timeInForce: TimeInForce.DAY,
      quantity: dec(5),
      limitPrice: quote.price.times(0.5),
    });

    await db.position.create({
      data: { portfolioId, symbol: 'AAPL', quantity: '10', averageEntryPrice: '150' },
    });

    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/risk/kill-switch',
      headers: session.headers(),
      payload: { reason: 'cancel resting orders', portfolioId },
    });

    expect(response.json().ordersCancelled).toBe(1);
    expect(await broker.getOrders({ openOnly: true })).toHaveLength(0);
    // Halting trading must never liquidate; that is a separate, confirmed action.
    expect(await db.position.count({ where: { portfolioId, status: 'OPEN' } })).toBe(1);
  });

  it('records the halt in the audit log and as a risk event', async () => {
    await harness.app.inject({
      method: 'POST',
      url: '/api/risk/kill-switch',
      headers: session.headers(),
      payload: { reason: 'auditable halt', portfolioId },
    });

    const entry = await db.auditLog.findFirst({
      where: { action: AuditAction.KILL_SWITCH_ACTIVATED, portfolioId },
    });
    expect(entry).not.toBeNull();
    expect(JSON.stringify(entry?.afterValue)).toContain('auditable halt');

    const riskEvent = await db.riskEvent.findFirst({ where: { portfolioId } });
    expect(riskEvent?.type).toBe('KILL_SWITCH_MANUAL');
    expect(riskEvent?.severity).toBe('CRITICAL');
  });

  it('is idempotent — halting twice does not double up', async () => {
    for (let i = 0; i < 2; i += 1) {
      await harness.app.inject({
        method: 'POST',
        url: '/api/risk/kill-switch',
        headers: session.headers(),
        payload: { reason: `halt ${i}`, portfolioId },
      });
    }
    const portfolio = await db.portfolio.findUniqueOrThrow({ where: { id: portfolioId } });
    expect(portfolio.tradingState).toBe(TradingState.HALTED);
  });

  it('will not resume a portfolio blocked by a reconciliation mismatch', async () => {
    const admin = await createUser(db, { email: 'boss@test.local', role: 'ADMIN' });
    await db.user.update({ where: { id: admin.id }, data: { mfaEnabled: false } });
    await db.portfolio.update({
      where: { id: portfolioId },
      data: { tradingState: TradingState.RECONCILIATION_ERROR },
    });

    // Sign the administrator in through the enrol-then-verify flow.
    const challenge = await harness.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'boss@test.local', password: 'TestPassword123!' },
    });
    const { mfaToken } = challenge.json();
    const enrol = await harness.app.inject({
      method: 'POST',
      url: '/api/auth/mfa/enrol',
      payload: { mfaToken },
    });
    const { currentTotp } = await import('../../src/modules/auth/mfa.js');
    const verify = await harness.app.inject({
      method: 'POST',
      url: '/api/auth/mfa/verify',
      payload: { mfaToken, totp: currentTotp(enrol.json().secret) },
    });
    const { sessionFromResponse } = await import('../helpers/app.js');
    const adminSession = sessionFromResponse(verify.cookies, verify.json().csrfToken);

    const resume = await harness.app.inject({
      method: 'POST',
      url: `/api/risk/portfolios/${portfolioId}/resume`,
      headers: adminSession.headers(),
      payload: { reason: 'trying to resume' },
    });

    expect(resume.statusCode).toBe(409);
    expect(resume.json().error.message).toMatch(/reconciliation/i);
  });

  it('requires a reason of substance', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/risk/kill-switch',
      headers: session.headers(),
      payload: { reason: 'x', portfolioId },
    });
    expect(response.statusCode).toBe(422);
  });
});
