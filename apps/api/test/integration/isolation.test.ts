import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditAction, UserRole } from '@zusu/shared';
import { buildTestApp, login, type Session, type TestApp } from '../helpers/app.js';
import { disconnectTestDb, resetDatabase, testDb } from '../helpers/db.js';
import {
  createClient,
  createPortfolio,
  createUser,
  grantPortfolioAccess,
} from '../helpers/fixtures.js';

/**
 * Client data isolation (§41).
 *
 * Two clients, each with their own portfolio and their own user. Nothing a
 * user of client A does may reveal anything about client B — and the tests
 * hit the HTTP surface, not the service layer, so a route that forgets to
 * scope its query fails here.
 */
let harness: TestApp;
const db = testDb();

let alice: { userId: string; portfolioId: string; clientId: string; session: Session };
let bob: { userId: string; portfolioId: string; clientId: string; session: Session };
let adminSession: Session;
let managerSession: Session;
let viewerSession: Session;

beforeAll(async () => {
  harness = await buildTestApp();
});

beforeEach(async () => {
  await resetDatabase();

  const clientA = await createClient(db, 'Client Alice');
  const clientB = await createClient(db, 'Client Bob');
  const portfolioA = await createPortfolio(db, { name: 'Alice Fund', clientId: clientA.id });
  const portfolioB = await createPortfolio(db, { name: 'Bob Fund', clientId: clientB.id });

  const aliceUser = await createUser(db, {
    email: 'alice@test.local',
    role: UserRole.CLIENT,
    clientId: clientA.id,
  });
  const bobUser = await createUser(db, {
    email: 'bob@test.local',
    role: UserRole.CLIENT,
    clientId: clientB.id,
  });
  await createUser(db, { email: 'manager@test.local', role: UserRole.MANAGER });
  const viewer = await createUser(db, { email: 'viewer@test.local', role: UserRole.VIEWER });
  await grantPortfolioAccess(db, viewer.id, portfolioA.id, false);

  // The administrator enrols in MFA, since the role demands it.
  const admin = await createUser(db, { email: 'admin@test.local', role: UserRole.ADMIN });
  await db.user.update({ where: { id: admin.id }, data: { mfaEnabled: false } });

  const managerUser = await db.user.findUniqueOrThrow({ where: { email: 'manager@test.local' } });
  await grantPortfolioAccess(db, managerUser.id, portfolioA.id, true);

  alice = {
    userId: aliceUser.id,
    portfolioId: portfolioA.id,
    clientId: clientA.id,
    session: await login(harness.app, 'alice@test.local'),
  };
  bob = {
    userId: bobUser.id,
    portfolioId: portfolioB.id,
    clientId: clientB.id,
    session: await login(harness.app, 'bob@test.local'),
  };
  managerSession = await login(harness.app, 'manager@test.local');
  viewerSession = await login(harness.app, 'viewer@test.local');
  adminSession = await loginAdmin();
});

afterAll(async () => {
  await harness?.close();
  await disconnectTestDb();
});

/** Signs an administrator in through the full enrol-then-verify flow. */
async function loginAdmin(): Promise<Session> {
  const challenge = await harness.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email: 'admin@test.local', password: 'TestPassword123!' },
  });
  const { mfaToken } = challenge.json();
  const enrol = await harness.app.inject({
    method: 'POST',
    url: '/api/auth/mfa/enrol',
    payload: { mfaToken },
  });
  const { secret } = enrol.json();
  const { currentTotp } = await import('../../src/modules/auth/mfa.js');
  const verify = await harness.app.inject({
    method: 'POST',
    url: '/api/auth/mfa/verify',
    payload: { mfaToken, totp: currentTotp(secret) },
  });
  const { sessionFromResponse } = await import('../helpers/app.js');
  return sessionFromResponse(verify.cookies, verify.json().csrfToken);
}

describe('portfolio isolation', () => {
  it('shows a client only their own portfolio', async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/portfolios',
      headers: { cookie: alice.session.cookies },
    });

    const portfolios = response.json();
    expect(portfolios).toHaveLength(1);
    expect(portfolios[0].id).toBe(alice.portfolioId);
    expect(JSON.stringify(portfolios)).not.toContain('Bob Fund');
  });

  it("hides another client's portfolio behind a 404, not a 403", async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url: `/api/portfolios/${bob.portfolioId}`,
      headers: { cookie: alice.session.cookies },
    });
    // A 403 would confirm the portfolio exists; 404 reveals nothing.
    expect(response.statusCode).toBe(404);
  });

  it("blocks every portfolio-scoped route for another client's id", async () => {
    for (const url of [
      `/api/portfolios/${bob.portfolioId}`,
      `/api/portfolios/${bob.portfolioId}/positions`,
      `/api/risk/portfolios/${bob.portfolioId}/gate`,
      `/api/risk/portfolios/${bob.portfolioId}/limits`,
      `/api/broker/${bob.portfolioId}/account`,
      `/api/broker/${bob.portfolioId}/positions`,
      `/api/broker/${bob.portfolioId}/quote/AAPL`,
    ]) {
      const response = await harness.app.inject({
        method: 'GET',
        url,
        headers: { cookie: alice.session.cookies },
      });
      expect([403, 404]).toContain(response.statusCode);
      expect(response.body).not.toContain('Bob Fund');
    }
  });

  it("never leaks another client's positions", async () => {
    await db.position.create({
      data: {
        portfolioId: bob.portfolioId,
        symbol: 'SECRET',
        quantity: '100',
        averageEntryPrice: '10',
      },
    });

    const own = await harness.app.inject({
      method: 'GET',
      url: `/api/portfolios/${alice.portfolioId}/positions`,
      headers: { cookie: alice.session.cookies },
    });
    expect(own.json()).toHaveLength(0);
    expect(own.body).not.toContain('SECRET');
  });

  it('records a denied cross-client attempt in the audit log', async () => {
    await harness.app.inject({
      method: 'GET',
      url: `/api/portfolios/${bob.portfolioId}`,
      headers: { cookie: alice.session.cookies },
    });

    const denied = await db.auditLog.findFirst({
      where: { action: AuditAction.PORTFOLIO_ACCESS_DENIED, actorUserId: alice.userId },
    });
    expect(denied).not.toBeNull();
    expect(denied?.entityId).toBe(bob.portfolioId);
  });

  it('lets an administrator see every portfolio', async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/portfolios',
      headers: { cookie: adminSession.cookies },
    });
    expect(response.json()).toHaveLength(2);
  });

  it('limits a manager to the portfolios granted to them', async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/portfolios',
      headers: { cookie: managerSession.cookies },
    });
    const ids = response.json().map((p: { id: string }) => p.id);
    expect(ids).toEqual([alice.portfolioId]);
  });
});

describe('role enforcement is server-side', () => {
  it('keeps the client roster away from clients and viewers', async () => {
    for (const session of [alice.session, viewerSession]) {
      const response = await harness.app.inject({
        method: 'GET',
        url: '/api/clients',
        headers: { cookie: session.cookies },
      });
      expect(response.statusCode).toBe(403);
    }
  });

  it('refuses portfolio writes from a read-only role', async () => {
    for (const session of [alice.session, viewerSession]) {
      const create = await harness.app.inject({
        method: 'POST',
        url: '/api/portfolios',
        headers: session.headers(),
        payload: { name: 'Sneaky', environment: 'DEMO', initialCapital: '1000' },
      });
      expect(create.statusCode).toBe(403);

      const patch = await harness.app.inject({
        method: 'PATCH',
        url: `/api/portfolios/${alice.portfolioId}`,
        headers: session.headers(),
        payload: { name: 'Renamed' },
      });
      expect(patch.statusCode).toBe(403);
    }
  });

  it('lets a manager halt trading but not release it', async () => {
    const halt = await harness.app.inject({
      method: 'POST',
      url: '/api/risk/kill-switch',
      headers: managerSession.headers(),
      payload: { reason: 'manager stopping trading', portfolioId: alice.portfolioId },
    });
    expect(halt.statusCode).toBe(200);

    const resume = await harness.app.inject({
      method: 'POST',
      url: `/api/risk/portfolios/${alice.portfolioId}/resume`,
      headers: managerSession.headers(),
      payload: { reason: 'manager resuming' },
    });
    expect(resume.statusCode).toBe(403);

    const adminResume = await harness.app.inject({
      method: 'POST',
      url: `/api/risk/portfolios/${alice.portfolioId}/resume`,
      headers: adminSession.headers(),
      payload: { reason: 'administrator resuming after review' },
    });
    expect(adminResume.statusCode).toBe(200);
  });

  it('keeps the audit log away from anyone but an administrator', async () => {
    for (const session of [alice.session, viewerSession, managerSession]) {
      const response = await harness.app.inject({
        method: 'GET',
        url: '/api/audit',
        headers: { cookie: session.cookies },
      });
      expect(response.statusCode).toBe(403);
    }

    const allowed = await harness.app.inject({
      method: 'GET',
      url: '/api/audit',
      headers: { cookie: adminSession.cookies },
    });
    expect(allowed.statusCode).toBe(200);
  });

  it('never exposes broker credentials over the API', async () => {
    await db.brokerAccount.create({
      data: {
        portfolioId: alice.portfolioId,
        environment: 'DEMO',
        broker: 'DEMO',
        label: 'demo account',
        credentialsEnc: 'v1:aaa:bbb:ccc',
      },
    });

    const response = await harness.app.inject({
      method: 'GET',
      url: `/api/broker/${alice.portfolioId}/account`,
      headers: { cookie: adminSession.cookies },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain('credentialsEnc');
    expect(response.body).not.toContain('v1:aaa');
  });
});
