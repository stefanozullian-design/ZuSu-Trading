import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditAction, UserRole } from '@zusu/shared';
import { buildTestApp, login, loginAdmin, type Session, type TestApp } from '../helpers/app.js';
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

  it('is visible to the person who made it', async () => {
    // A manager is scoped to explicit grants and their own client's books, and
    // a brand-new portfolio has neither — so without a grant the API returned
    // 201 and the thing vanished from every list.
    const created = await harness.app.inject({
      method: 'POST',
      url: '/api/portfolios',
      headers: session.headers(),
      payload: { name: 'Mine To See', environment: 'DEMO', initialCapital: '10000' },
    });
    expect(created.statusCode).toBe(201);

    const listed = await harness.app.inject({
      method: 'GET',
      url: '/api/portfolios',
      headers: { cookie: session.cookies },
    });
    const names = (listed.json() as { name: string }[]).map((p) => p.name);
    expect(names).toContain('Mine To See');
  });

  it('lets the person who made it trade it', async () => {
    const created = await harness.app.inject({
      method: 'POST',
      url: '/api/portfolios',
      headers: session.headers(),
      payload: { name: 'Mine To Trade', environment: 'DEMO', initialCapital: '10000' },
    });
    const { id } = created.json() as { id: string };

    // Seeing a book and moving it are different rights, and creating one
    // should confer both — otherwise the next step after "create" is a
    // permission error nobody can resolve from the screen they are on.
    const grant = await db.portfolioAccess.findFirstOrThrow({ where: { portfolioId: id } });
    expect(grant.canTrade).toBe(true);
  });

  it('renames without touching anything else', async () => {
    const created = await harness.app.inject({
      method: 'POST',
      url: '/api/portfolios',
      headers: session.headers(),
      payload: { name: 'Typo Fund', environment: 'DEMO', initialCapital: '10000' },
    });
    const { id } = created.json() as { id: string };

    const renamed = await harness.app.inject({
      method: 'PATCH',
      url: `/api/portfolios/${id}`,
      headers: session.headers(),
      payload: { name: 'Properly Named Fund' },
    });

    expect(renamed.statusCode).toBe(200);
    expect((renamed.json() as { name: string }).name).toBe('Properly Named Fund');
    const row = await db.portfolio.findUniqueOrThrow({ where: { id } });
    expect(Number(row.cashBalance)).toBe(10_000);
    expect(row.isActive).toBe(true);
  });

  it('closes a portfolio, hiding it from the list without deleting it', async () => {
    const created = await harness.app.inject({
      method: 'POST',
      url: '/api/portfolios',
      headers: session.headers(),
      payload: { name: 'Made By Mistake', environment: 'DEMO', initialCapital: '1000' },
    });
    const { id } = created.json() as { id: string };

    await harness.app.inject({
      method: 'PATCH',
      url: `/api/portfolios/${id}`,
      headers: session.headers(),
      payload: { isActive: false },
    });

    const listed = await harness.app.inject({
      method: 'GET',
      url: '/api/portfolios',
      headers: { cookie: session.cookies },
    });
    expect((listed.json() as { id: string }[]).map((p) => p.id)).not.toContain(id);

    // Hidden, never erased: the row and its audit history are both intact.
    expect(await db.portfolio.findUnique({ where: { id } })).not.toBeNull();

    const withClosed = await harness.app.inject({
      method: 'GET',
      url: '/api/portfolios?includeClosed=true',
      headers: { cookie: session.cookies },
    });
    expect((withClosed.json() as { id: string }[]).map((p) => p.id)).toContain(id);
  });

  it('refuses to close a portfolio that still holds something', async () => {
    const created = await harness.app.inject({
      method: 'POST',
      url: '/api/portfolios',
      headers: session.headers(),
      payload: { name: 'Still Invested', environment: 'DEMO', initialCapital: '10000' },
    });
    const { id } = created.json() as { id: string };
    await db.position.create({
      data: { portfolioId: id, symbol: 'AAPL', quantity: '10', averageEntryPrice: '180' },
    });

    const closed = await harness.app.inject({
      method: 'PATCH',
      url: `/api/portfolios/${id}`,
      headers: session.headers(),
      payload: { isActive: false },
    });

    // A hidden book you still hold shares in is a book nobody is watching.
    expect(closed.statusCode).toBe(409);
    expect(closed.json().error.message).toContain('still holds 1 open position');
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
    // Nothing claims to be running that is not. Claude is disabled because
    // this deployment has no API key; the scheduler because a test app builds
    // no timers; reconciliation because it does not exist yet.
    expect(byName.CLAUDE).toBe('DISABLED');
    expect(byName.RECONCILIATION).toBe('DISABLED');
    expect(byName.SCHEDULER).toBe('DISABLED');
    // True since Phase 5: an order can be placed in this environment. It says
    // nothing about whether one should be — the approval gate is a person's,
    // and a halted portfolio still refuses.
    expect(health.tradingEnabled).toBe(true);
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

/**
 * Owners and objectives.
 *
 * One person managing money for several people is the ordinary case, not an
 * enterprise one: their own portfolios, a parent's, each split by what the
 * money is for. Two properties matter and neither is obvious from the schema.
 * A name only has to be unique within an owner, because "Retirement" is what
 * everybody calls that portfolio. And the objective is not a label — it picks
 * the limits the portfolio starts under, so money meant for a retirement does
 * not begin life with a day trader's appetite.
 */
describe('who a portfolio belongs to', () => {
  // Created directly: registering a new person whose money is under
  // management needs `client:write`, which is administrator-only. A manager
  // assigns portfolios to owners that already exist, and the test below pins
  // that boundary rather than working around it here.
  async function owner(name: string): Promise<string> {
    const client = await db.client.create({ data: { name } });
    return client.id;
  }

  async function make(payload: Record<string, unknown>) {
    return harness.app.inject({
      method: 'POST',
      url: '/api/portfolios',
      headers: session.headers(),
      payload: { environment: 'DEMO', initialCapital: '50000', ...payload },
    });
  }

  it('lets two people each have a portfolio with the same name', async () => {
    const [mine, mum] = [await owner('Stefano'), await owner('Mum')];

    expect((await make({ name: 'Retirement', clientId: mine })).statusCode).toBe(201);
    const second = await make({ name: 'Retirement', clientId: mum });

    // The whole point of an owner. Requiring "Mum — Retirement" would make the
    // owner field decorative.
    expect(second.statusCode).toBe(201);
    expect(second.json().clientName).toBe('Mum');
  });

  it('still refuses the same name twice for one person', async () => {
    const mine = await owner('Stefano');
    await make({ name: 'Retirement', clientId: mine });

    expect((await make({ name: 'Retirement', clientId: mine })).statusCode).toBe(409);
  });

  it('refuses the same name twice among the unassigned ones', async () => {
    await make({ name: 'Scratch' });

    // PostgreSQL treats NULLs as distinct by default, which would have let any
    // number of unowned portfolios share a name. The constraint says
    // NULLS NOT DISTINCT precisely so this is a conflict.
    expect((await make({ name: 'Scratch' })).statusCode).toBe(409);
  });

  it('filters the list to one owner', async () => {
    const [mine, mum] = [await owner('Stefano'), await owner('Mum')];
    await make({ name: 'Day trading', clientId: mine });
    await make({ name: 'Retirement', clientId: mum });
    await make({ name: 'Retirement', clientId: mine });

    const response = await harness.app.inject({
      method: 'GET',
      url: `/api/portfolios?ownerId=${mine}`,
      headers: session.headers(),
    });

    const names = (response.json() as { name: string }[]).map((p) => p.name).sort();
    expect(names).toEqual(['Day trading', 'Retirement']);
  });

  it('finds the ones nobody has been assigned to', async () => {
    const mine = await owner('Stefano');
    await make({ name: 'Assigned', clientId: mine });
    await make({ name: 'Forgotten' });

    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/portfolios?ownerId=none',
      headers: session.headers(),
    });

    // Asking for the unassigned ones is how a person finds what they forgot,
    // so it has to be a filter rather than the absence of one.
    const rows = response.json() as { name: string; clientId: string | null }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe('Forgotten');
    expect(rows[0]?.clientId).toBeNull();
  });

  it('reassigns an owner, and says so on both sides of the audit entry', async () => {
    const [mine, mum] = [await owner('Stefano'), await owner('Mum')];
    const created = (await make({ name: 'Set up wrong', clientId: mine })).json();

    const response = await harness.app.inject({
      method: 'PATCH',
      url: `/api/portfolios/${created.id}`,
      headers: session.headers(),
      payload: { clientId: mum },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().clientName).toBe('Mum');

    // The reporting link follows the column; leaving them to drift would make
    // two parts of the app disagree about the same portfolio.
    const links = await db.clientPortfolio.findMany({ where: { portfolioId: created.id } });
    expect(links.map((l) => l.clientId)).toEqual([mum]);

    const entry = await db.auditLog.findFirstOrThrow({
      where: { entityId: created.id, action: AuditAction.PORTFOLIO_MODIFIED },
      orderBy: { seq: 'desc' },
    });
    expect((entry.beforeValue as { clientId: string }).clientId).toBe(mine);
    expect((entry.afterValue as { clientId: string }).clientId).toBe(mum);
  });

  it('lets a manager register a new owner', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/clients',
      headers: session.headers(),
      payload: { name: 'Somebody new' },
    });

    // This was administrator-only, on the reasoning that somebody able to
    // invent an owner could quietly move a book to one. The separation is real
    // in a firm and absent in the installation this is used in, where the same
    // person does both — and moving a portfolio between owners was always a
    // manager's action anyway, so the permission never gated that.
    expect(response.statusCode).toBe(201);
  });

  it('keeps the owner visible after an unrelated edit', async () => {
    const mine = await owner('Stefano');
    const created = (await make({ name: 'Before', clientId: mine })).json();

    const response = await harness.app.inject({
      method: 'PATCH',
      url: `/api/portfolios/${created.id}`,
      headers: session.headers(),
      payload: { name: 'After' },
    });

    // A rename reported the portfolio as unowned, which nobody saw while the
    // owner was invisible on screen and which reads as "renaming cleared the
    // owner" now that it is not.
    expect(response.json().clientName).toBe('Stefano');
  });
});

describe('what a portfolio is for', () => {
  async function limitsFor(objective: string | undefined) {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/portfolios',
      headers: session.headers(),
      payload: {
        name: `Fund ${objective ?? 'unstated'}`,
        environment: 'DEMO',
        initialCapital: '100000',
        ...(objective ? { objective } : {}),
      },
    });
    expect(response.statusCode).toBe(201);
    return db.riskLimit.findFirstOrThrow({
      where: { portfolioId: response.json().id as string, isActive: true },
    });
  }

  it('starts a retirement portfolio far tighter than a day-trading one', async () => {
    const [day, retirement] = [await limitsFor('DAY_TRADING'), await limitsFor('RETIREMENT')];

    // Money that must still be there in decades cannot share a day trader's
    // drawdown. 2% of capital against 0.5%, twenty trades a day against two.
    expect(Number(day.maxDailyLoss)).toBeCloseTo(2000, 6);
    expect(Number(retirement.maxDailyLoss)).toBeCloseTo(500, 6);
    expect(day.maxTradesPerDay).toBe(20);
    expect(retirement.maxTradesPerDay).toBe(2);
  });

  it('leaves a portfolio with no stated objective on the limits it always had', async () => {
    const unstated = await limitsFor(undefined);

    // Tightening limits under portfolios that already exist would change how
    // they behave without anyone asking.
    expect(Number(unstated.maxDailyLoss)).toBeCloseTo(2000, 6);
    expect(unstated.maxTradesPerDay).toBe(20);
  });

  it('says which objective the starting limits came from', async () => {
    const income = await limitsFor('INCOME');

    // A person reading the risk history a year later can see why these
    // particular numbers were the starting point.
    expect(income.changeReason).toContain('INCOME');
  });

  it('records no objective rather than inventing one', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/portfolios',
      headers: session.headers(),
      payload: { name: 'Unstated', environment: 'DEMO', initialCapital: '1000' },
    });

    expect(response.json().objective).toBeNull();
  });
});

/**
 * Managing the owners themselves.
 *
 * An owner can be renamed, given a contact, and retired — but never deleted.
 * Every one of them is referenced by append-only audit rows from the moment
 * they exist, so removing one would mean rewriting a trading record, which the
 * database refuses and rightly.
 */
describe('editing an owner', () => {
  let admin: Session;

  beforeEach(async () => {
    await createUser(db, { email: 'owner-admin@test.local', role: UserRole.ADMIN });
    // The whole enrol-then-verify flow: an administrator cannot get a session
    // without a second factor, which is exactly the friction being tested for
    // everywhere else this permission is required.
    admin = await loginAdmin(harness.app, 'owner-admin@test.local');
  });

  async function owner(name: string): Promise<string> {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/clients',
      headers: admin.headers(),
      payload: { name },
    });
    expect(response.statusCode).toBe(201);
    return response.json().id as string;
  }

  it('renames one, and records both sides', async () => {
    const id = await owner('Mum');

    const response = await harness.app.inject({
      method: 'PATCH',
      url: `/api/clients/${id}`,
      headers: admin.headers(),
      payload: { name: 'Mother' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().name).toBe('Mother');

    const entry = await db.auditLog.findFirstOrThrow({
      where: { entityId: id, action: AuditAction.CLIENT_MODIFIED },
      orderBy: { seq: 'desc' },
    });
    expect((entry.beforeValue as { name: string }).name).toBe('Mum');
    expect((entry.afterValue as { name: string }).name).toBe('Mother');
  });

  it('clears a contact rather than only ever setting one', async () => {
    const id = await owner('Typo Person');
    await harness.app.inject({
      method: 'PATCH',
      url: `/api/clients/${id}`,
      headers: admin.headers(),
      payload: { contactEmail: 'wrong@example.com' },
    });

    const cleared = await harness.app.inject({
      method: 'PATCH',
      url: `/api/clients/${id}`,
      headers: admin.headers(),
      payload: { contactEmail: null },
    });

    // A field that can only be set and never cleared makes a typo permanent.
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().contactEmail).toBeNull();
  });

  it('retires one, taking them out of the list without deleting them', async () => {
    const id = await owner('Retired Person');

    const retired = await harness.app.inject({
      method: 'PATCH',
      url: `/api/clients/${id}`,
      headers: admin.headers(),
      payload: { isActive: false },
    });
    expect(retired.statusCode).toBe(200);

    const listed = await harness.app.inject({
      method: 'GET',
      url: '/api/clients',
      headers: admin.headers(),
    });
    expect((listed.json() as { id: string }[]).map((c) => c.id)).not.toContain(id);

    // Still there, and findable, because the audit rows that name them cannot
    // be rewritten.
    const all = await harness.app.inject({
      method: 'GET',
      url: '/api/clients?includeInactive=true',
      headers: admin.headers(),
    });
    expect((all.json() as { id: string }[]).map((c) => c.id)).toContain(id);
    expect(await db.client.findUnique({ where: { id } })).not.toBeNull();
  });

  it('refuses to retire somebody whose money is still being traded', async () => {
    const id = await owner('Still Trading');
    await harness.app.inject({
      method: 'POST',
      url: '/api/portfolios',
      headers: session.headers(),
      payload: {
        name: 'Open book',
        environment: 'DEMO',
        initialCapital: '1000',
        clientId: id,
      },
    });

    const response = await harness.app.inject({
      method: 'PATCH',
      url: `/api/clients/${id}`,
      headers: admin.headers(),
      payload: { isActive: false },
    });

    // Retiring them would take them out of every picker while their book is
    // still open — hiding the book rather than the person.
    expect(response.statusCode).toBe(409);
    expect(response.json().error.message).toMatch(/still owns/i);
  });

  it('brings a retired owner back', async () => {
    const id = await owner('Returning');
    await harness.app.inject({
      method: 'PATCH',
      url: `/api/clients/${id}`,
      headers: admin.headers(),
      payload: { isActive: false },
    });

    const back = await harness.app.inject({
      method: 'PATCH',
      url: `/api/clients/${id}`,
      headers: admin.headers(),
      payload: { isActive: true },
    });

    expect(back.statusCode).toBe(200);
    expect(back.json().isActive).toBe(true);
  });

  it('offers no way to delete one at all', async () => {
    const id = await owner('Permanent');

    const response = await harness.app.inject({
      method: 'DELETE',
      url: `/api/clients/${id}`,
      headers: admin.headers(),
    });

    // Not 403 — the route does not exist. Deleting an owner would leave audit
    // rows pointing at nothing, or require rewriting them.
    expect(response.statusCode).toBe(404);
  });

  it('lets a manager edit one, and still refuses a viewer', async () => {
    const id = await owner('Editable');

    const byManager = await harness.app.inject({
      method: 'PATCH',
      url: `/api/clients/${id}`,
      headers: session.headers(),
      payload: { name: 'Renamed by a manager' },
    });
    expect(byManager.statusCode).toBe(200);

    await createUser(db, { email: 'owner-viewer@test.local', role: UserRole.VIEWER });
    const viewer = await login(harness.app, 'owner-viewer@test.local');
    const byViewer = await harness.app.inject({
      method: 'PATCH',
      url: `/api/clients/${id}`,
      headers: viewer.headers(),
      payload: { name: 'Renamed by a viewer' },
    });

    // Widening one permission must not widen the ones either side of it.
    expect(byViewer.statusCode).toBe(403);
  });
});
