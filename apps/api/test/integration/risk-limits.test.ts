import { AuditAction, UserRole } from '@zusu/shared';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, login, loginAdmin, type Session, type TestApp } from '../helpers/app.js';
import { disconnectTestDb, resetDatabase, testDb } from '../helpers/db.js';
import { createPortfolio, createUser, grantPortfolioAccess } from '../helpers/fixtures.js';

/**
 * Changing a portfolio's risk limits.
 *
 * There was no way to. The permission existed in the matrix and nothing used
 * it, so a portfolio kept for ever the numbers derived from its opening
 * capital — which goes badly wrong as soon as holdings are imported, since
 * importing adds value without adding cash and leaves a $1,000 limit guarding
 * an $18,000 book.
 *
 * A manager may change them. That was administrator-only, and the argument for
 * it — an account that can raise its own limits has limits in name only —
 * describes a firm, where the person who trades and the person who sets the
 * ceiling are different people. Here they are the same person, and the
 * separation bought a second login rather than a second opinion.
 *
 * So what it was protecting has to live in the change itself, and that is what
 * these tests are about: a new version every time, the previous numbers still
 * readable, a reason that is not optional, and both sides in the audit log. A
 * limit can be raised, and never quietly.
 */

let harness: TestApp;
const db = testDb();
let admin: Session;
let manager: Session;
let portfolioId: string;

const change = {
  maxDailyLoss: '270.00',
  maxWeeklyLoss: '720.00',
  maxPositionSize: '1440.00',
  maxPortfolioExposurePct: '55',
  maxSectorExposurePct: '25',
  maxSymbolExposurePct: '12',
  maxOpenPositions: 8,
  maxTradesPerDay: 6,
  maxConsecutiveLosses: 3,
  maxDrawdownPct: '12',
  reason: 'Holdings imported; the limits were set for the opening cash only',
};

beforeEach(async () => {
  await resetDatabase();
  harness ??= await buildTestApp();

  const portfolio = await createPortfolio(db, { name: 'Limited', environment: 'DEMO' });
  portfolioId = portfolio.id;

  const adminUser = await createUser(db, { email: 'risk-admin@test.local', role: UserRole.ADMIN });
  await grantPortfolioAccess(db, adminUser.id, portfolioId, true);
  admin = await loginAdmin(harness.app, 'risk-admin@test.local');

  const managerUser = await createUser(db, {
    email: 'risk-manager@test.local',
    role: UserRole.MANAGER,
  });
  await grantPortfolioAccess(db, managerUser.id, portfolioId, true);
  manager = await login(harness.app, 'risk-manager@test.local');

  // The fixture already writes version 1; these are the tight numbers a
  // $1,000 portfolio would carry after holdings were imported into it.
  await db.riskLimit.updateMany({
    where: { portfolioId, isActive: true },
    data: {
      maxDailyLoss: '15',
      maxWeeklyLoss: '40',
      maxPositionSize: '80',
      maxPortfolioExposurePct: '40',
      maxSectorExposurePct: '15',
      maxSymbolExposurePct: '8',
      maxOpenPositions: 5,
      maxTradesPerDay: 2,
      maxConsecutiveLosses: 2,
      maxDrawdownPct: '8',
    },
  });
});

afterAll(async () => {
  await harness?.close();
  await disconnectTestDb();
});

function put(session: Session, payload: Record<string, unknown>) {
  return harness.app.inject({
    method: 'PUT',
    url: `/api/risk/portfolios/${portfolioId}/limits`,
    headers: session.headers(),
    payload,
  });
}

describe('changing risk limits', () => {
  it('writes a new version and leaves the old one readable', async () => {
    const response = await put(admin, change);

    expect(response.statusCode).toBe(200);
    expect(response.json().version).toBe(2);
    expect(response.json().maxDailyLoss).toBe('270');

    // Superseded, not overwritten: the numbers that refused something last
    // week have to still be legible this week.
    const previous = await db.riskLimit.findFirstOrThrow({ where: { portfolioId, version: 1 } });
    expect(previous.isActive).toBe(false);
    expect(previous.maxDailyLoss.toString()).toBe('15');

    const active = await db.riskLimit.findFirstOrThrow({ where: { portfolioId, isActive: true } });
    expect(active.version).toBe(2);
  });

  it('records who changed them and why', async () => {
    await put(admin, change);

    const active = await db.riskLimit.findFirstOrThrow({ where: { portfolioId, isActive: true } });
    expect(active.changeReason).toMatch(/opening cash/i);
    expect(active.changedById).not.toBeNull();

    const entry = await db.auditLog.findFirstOrThrow({
      where: { portfolioId, action: AuditAction.RISK_LIMIT_CHANGED },
      orderBy: { seq: 'desc' },
    });
    expect((entry.beforeValue as { maxDailyLoss: string }).maxDailyLoss).toBe('15');
    expect((entry.afterValue as { maxDailyLoss: string }).maxDailyLoss).toBe('270');
  });

  it('refuses a change with no reason worth reading', async () => {
    // The numbers are easy to read afterwards and impossible to interpret
    // without knowing why they moved.
    expect((await put(admin, { ...change, reason: 'because' })).statusCode).toBe(422);
    expect(await db.riskLimit.count({ where: { portfolioId } })).toBe(1);
  });

  it('lets a manager change them, and records it the same way', async () => {
    const response = await put(manager, change);

    expect(response.statusCode).toBe(200);

    const active = await db.riskLimit.findFirstOrThrow({ where: { portfolioId, isActive: true } });
    // Whoever changes it, the change is versioned, reasoned and attributed.
    expect(active.version).toBe(2);
    expect(active.changeReason).toMatch(/opening cash/i);
    expect(active.changedById).not.toBeNull();
  });

  it('still refuses a viewer', async () => {
    await createUser(db, { email: 'risk-viewer@test.local', role: UserRole.VIEWER });
    const viewer = await login(harness.app, 'risk-viewer@test.local');

    // Widening the permission for one role must not widen it for every role.
    const response = await put(viewer, change);

    expect(response.statusCode).toBe(403);
    expect(await db.riskLimit.count({ where: { portfolioId } })).toBe(1);
  });

  it('keeps every version, so the history of a limit is readable', async () => {
    await put(admin, change);
    await put(admin, { ...change, maxDailyLoss: '300.00', reason: 'Book grew after a deposit' });

    const versions = await db.riskLimit.findMany({
      where: { portfolioId },
      orderBy: { version: 'asc' },
    });
    expect(versions.map((v) => v.version)).toEqual([1, 2, 3]);
    expect(versions.filter((v) => v.isActive)).toHaveLength(1);
  });
});
