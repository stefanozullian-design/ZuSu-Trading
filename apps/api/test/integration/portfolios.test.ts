import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditAction, UserRole } from '@zusu/shared';
import { buildTestApp, login, type Session, type TestApp } from '../helpers/app.js';
import { disconnectTestDb, resetDatabase, testDb } from '../helpers/db.js';
import { createPortfolio, createUser, grantPortfolioAccess } from '../helpers/fixtures.js';

let harness: TestApp;
const db = testDb();
let session: Session;

beforeEach(async () => {
  await resetDatabase();
  harness ??= await buildTestApp();
  harness.container.brokers.reset();
  await createUser(db, { email: 'pm@test.local', role: UserRole.MANAGER });
  session = await login(harness.app, 'pm@test.local');
});

afterAll(async () => {
  await harness?.close();
  await disconnectTestDb();
});

describe('creating a portfolio', () => {
  it('starts with conservative risk limits derived from capital', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/portfolios',
      headers: session.headers(),
      payload: { name: 'New Fund', environment: 'DEMO', initialCapital: '50000' },
    });

    expect(response.statusCode).toBe(201);
    const portfolio = response.json();
    expect(portfolio.cashBalance).toBe('50000.00');
    expect(portfolio.executionMode).toBe('MANUAL_APPROVAL');
    expect(portfolio.tradingState).toBe('ACTIVE');

    const limits = await db.riskLimit.findFirstOrThrow({
      where: { portfolioId: portfolio.id, isActive: true },
    });
    // 2% of capital as a daily loss limit, 10% as a maximum position.
    expect(Number(limits.maxDailyLoss)).toBeCloseTo(1000, 6);
    expect(Number(limits.maxPositionSize)).toBeCloseTo(5000, 6);
  });

  it('records the creation in the audit log', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/portfolios',
      headers: session.headers(),
      payload: { name: 'Audited Fund', environment: 'DEMO', initialCapital: '1000' },
    });

    const entry = await db.auditLog.findFirst({
      where: { action: AuditAction.PORTFOLIO_CREATED, portfolioId: response.json().id },
    });
    expect(entry).not.toBeNull();
    expect(entry?.environment).toBe('DEMO');
  });

  it('refuses a live portfolio while live trading is disabled', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/portfolios',
      headers: session.headers(),
      payload: { name: 'Live Fund', environment: 'LIVE', initialCapital: '10000' },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('LIVE_TRADING_DISABLED');
    expect(await db.portfolio.count()).toBe(0);
  });

  it('rejects a non-positive initial capital', async () => {
    for (const initialCapital of ['0', '-100']) {
      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/portfolios',
        headers: session.headers(),
        payload: { name: `Bad ${initialCapital}`, environment: 'DEMO', initialCapital },
      });
      expect(response.statusCode).toBe(422);
    }
  });

  it('rejects money sent as a float rather than a decimal string', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/portfolios',
      headers: session.headers(),
      payload: { name: 'Floaty', environment: 'DEMO', initialCapital: 1000.5 },
    });
    expect(response.statusCode).toBe(422);
  });
});

describe('portfolio summary arithmetic', () => {
  it('marks positions from the environment’s market-data source', async () => {
    const portfolio = await createPortfolio(db, { name: 'Marked', initialCapital: '10000' });
    const managerUser = await db.user.findUniqueOrThrow({ where: { email: 'pm@test.local' } });
    await grantPortfolioAccess(db, managerUser.id, portfolio.id, true);
    await db.position.create({
      data: { portfolioId: portfolio.id, symbol: 'AAPL', quantity: '10', averageEntryPrice: '150' },
    });

    const response = await harness.app.inject({
      method: 'GET',
      url: `/api/portfolios/${portfolio.id}`,
      headers: { cookie: session.cookies },
    });

    const summary = response.json();
    expect(summary.positionsValue).not.toBeNull();
    expect(summary.equity).not.toBeNull();
    // equity = cash + positions value, to the cent.
    expect(Number(summary.equity)).toBeCloseTo(
      Number(summary.cashBalance) + Number(summary.positionsValue),
      2,
    );
    expect(summary.openPositions).toBe(1);
  });

  it('reports no mark rather than substituting the entry price', async () => {
    // A PAPER portfolio has no market-data provider configured in Phase 1.
    const paper = await createPortfolio(db, { name: 'Paper', environment: 'PAPER' });
    const managerUser = await db.user.findUniqueOrThrow({ where: { email: 'pm@test.local' } });
    await grantPortfolioAccess(db, managerUser.id, paper.id, false);
    await db.position.create({
      data: { portfolioId: paper.id, symbol: 'AAPL', quantity: '10', averageEntryPrice: '150' },
    });

    const positions = await harness.app.inject({
      method: 'GET',
      url: `/api/portfolios/${paper.id}/positions`,
      headers: { cookie: session.cookies },
    });
    const [position] = positions.json();
    expect(position.markPrice).toBeNull();
    expect(position.marketValue).toBeNull();
    expect(position.unrealizedPnl).toBeNull();

    const summary = await harness.app.inject({
      method: 'GET',
      url: `/api/portfolios/${paper.id}`,
      headers: { cookie: session.cookies },
    });
    expect(summary.json().equity).toBeNull();
  });

  it('reports no daily P&L until a prior snapshot exists', async () => {
    const portfolio = await createPortfolio(db, { name: 'Fresh' });
    const managerUser = await db.user.findUniqueOrThrow({ where: { email: 'pm@test.local' } });
    await grantPortfolioAccess(db, managerUser.id, portfolio.id, false);

    const response = await harness.app.inject({
      method: 'GET',
      url: `/api/portfolios/${portfolio.id}`,
      headers: { cookie: session.cookies },
    });
    expect(response.json().dailyPnl).toBeNull();
    expect(response.json().dailyPnlPct).toBeNull();
  });

  it('excludes deposits from the daily P&L (§42)', async () => {
    const portfolio = await createPortfolio(db, { name: 'Funded', initialCapital: '10000' });
    const managerUser = await db.user.findUniqueOrThrow({ where: { email: 'pm@test.local' } });
    await grantPortfolioAccess(db, managerUser.id, portfolio.id, false);

    const yesterday = new Date();
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    await db.portfolioSnapshot.create({
      data: {
        portfolioId: portfolio.id,
        asOf: yesterday,
        cashBalance: '10000',
        positionsValue: '0',
        equity: '10000',
      },
    });

    // A $5,000 deposit today, with no trading at all.
    await db.cashFlow.create({
      data: {
        portfolioId: portfolio.id,
        type: 'DEPOSIT',
        amount: '5000',
        occurredAt: new Date(),
      },
    });
    await db.portfolio.update({
      where: { id: portfolio.id },
      data: { cashBalance: '15000' },
    });

    const response = await harness.app.inject({
      method: 'GET',
      url: `/api/portfolios/${portfolio.id}`,
      headers: { cookie: session.cookies },
    });

    // Naively this would read as +$5,000 of profit; it is exactly zero.
    expect(Number(response.json().dailyPnl)).toBeCloseTo(0, 2);
  });
});

describe('system endpoints', () => {
  it('answers the liveness probe without a session', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/api/system/live' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('reports which services are running and which are not built yet', async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/system/health',
      headers: { cookie: session.cookies },
    });

    const health = response.json();
    expect(health.environment).toBe('DEMO');
    const byName = Object.fromEntries(
      health.services.map((s: { service: string; status: string }) => [s.service, s.status]),
    );
    expect(byName.DATABASE).toBe('HEALTHY');
    expect(byName.BROKER).toBe('HEALTHY');
    // Nothing claims to be running that is not.
    expect(byName.CLAUDE).toBe('DISABLED');
    expect(byName.RECONCILIATION).toBe('DISABLED');
    expect(byName.SCHEDULER).toBe('DISABLED');
    expect(health.tradingEnabled).toBe(false);
  });

  it('describes the current environment', async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/system/environment',
      headers: { cookie: session.cookies },
    });
    const body = response.json();
    expect(body.environment).toBe('DEMO');
    expect(body.usesRealMoney).toBe(false);
    expect(body.liveTradingAllowed).toBe(false);
  });

  it('never exposes a secret through an endpoint or an error', async () => {
    const responses = await Promise.all([
      harness.app.inject({ method: 'GET', url: '/api/system/live' }),
      harness.app.inject({
        method: 'GET',
        url: '/api/system/health',
        headers: { cookie: session.cookies },
      }),
      harness.app.inject({ method: 'GET', url: '/api/does-not-exist' }),
    ]);

    for (const response of responses) {
      expect(response.body).not.toContain(process.env.JWT_SECRET as string);
      expect(response.body).not.toContain(process.env.CREDENTIAL_ENCRYPTION_KEY as string);
      expect(response.body).not.toContain('postgresql://');
    }
  });
});
