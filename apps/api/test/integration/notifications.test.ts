import { UserRole } from '@zusu/shared';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildContainer, type AppContainer } from '../../src/container.js';
import type { Principal } from '../../src/modules/rbac/access-control.js';
import { buildTestApp, login } from '../helpers/app.js';
import { disconnectTestDb, resetDatabase, testDb } from '../helpers/db.js';
import {
  createClient,
  createPortfolio,
  createUser,
  grantPortfolioAccess,
} from '../helpers/fixtures.js';

/**
 * Notifications.
 *
 * The interesting behaviour is the refusal: a channel with no transport behind
 * it is rejected rather than recorded as SENT. A notification marked sent that
 * nothing sent is worse than no notification, because somebody plans around it.
 */

const db = testDb();
let container: AppContainer;
let owner: Principal;
let stranger: Principal;
let portfolioId: string;

beforeEach(async () => {
  await resetDatabase();
  container ??= buildContainer({ db });

  const client = await createClient(db, 'Acme');
  const user = await createUser(db, { email: 'ops@test.local', role: UserRole.MANAGER });
  const other = await createUser(db, { email: 'other@test.local', role: UserRole.MANAGER });
  owner = { ...user };
  stranger = { ...other };

  const portfolio = await createPortfolio(db, { name: 'Alpha', clientId: client.id });
  portfolioId = portfolio.id;
  await grantPortfolioAccess(db, user.id, portfolio.id, true);
});

afterAll(async () => {
  await disconnectTestDb();
});

describe('delivery', () => {
  it('records one per person who can see the portfolio', async () => {
    const count = await container.notifications.notifyPortfolio({
      portfolioId,
      event: 'SIGNAL_AWAITING_APPROVAL',
      title: 'AAPL LONG — waiting for a decision',
      body: 'It will sit there until somebody decides.',
    });

    expect(count).toBe(1);
    const mine = await container.notifications.listFor(owner);
    expect(mine[0]?.title).toContain('AAPL');
    // Delivered by being readable, so it is SENT the moment it is stored.
    expect(mine[0]?.status).toBe('SENT');
    expect(mine[0]?.channel).toBe('BROWSER');
  });

  it('refuses a channel it has no transport for', async () => {
    await expect(
      container.notifications.notifyPortfolio({
        portfolioId,
        event: 'TEST',
        title: 'x',
        body: 'y',
        // @ts-expect-error — deliberately asking for a channel that does not work
        channel: 'EMAIL',
      }),
    ).rejects.toThrow(/no transport/);

    expect(await db.notification.count()).toBe(0);
  });

  it('never fails the thing it was notifying about', async () => {
    // A portfolio nobody can see: nothing to deliver, and no throw.
    const orphan = await createPortfolio(db, { name: 'Orphan' });
    await expect(
      container.notifications.notifySafe({
        portfolioId: orphan.id,
        event: 'TEST',
        title: 'x',
        body: 'y',
      }),
    ).resolves.toBeUndefined();
  });
});

describe('reading and dismissing', () => {
  it('shows a person only their own', async () => {
    await container.notifications.notifyPortfolio({
      portfolioId,
      event: 'TEST',
      title: 'yours',
      body: 'body',
    });

    expect(await container.notifications.listFor(owner)).toHaveLength(1);
    expect(await container.notifications.listFor(stranger)).toHaveLength(0);
  });

  it('refuses to dismiss somebody else’s, without confirming it exists', async () => {
    await container.notifications.notifyPortfolio({
      portfolioId,
      event: 'TEST',
      title: 'yours',
      body: 'body',
    });
    const [mine] = await container.notifications.listFor(owner);

    await expect(container.notifications.dismiss(stranger, mine!.id)).rejects.toThrow(/not found/);
    expect(await db.notification.count()).toBe(1);
  });

  it('removes a dismissed notification', async () => {
    await container.notifications.notifyPortfolio({
      portfolioId,
      event: 'TEST',
      title: 'yours',
      body: 'body',
    });
    const [mine] = await container.notifications.listFor(owner);

    await container.notifications.dismiss(owner, mine!.id);
    expect(await container.notifications.listFor(owner)).toHaveLength(0);
  });

  it('refuses a portfolio view to somebody with no access to it', async () => {
    await expect(container.notifications.listForPortfolio(stranger, portfolioId)).rejects.toThrow(
      /not found/,
    );
  });
});

describe('over HTTP', () => {
  it('requires a session — authentication in this API is per route, not global', async () => {
    const app = await buildTestApp();
    const anonymous = await app.app.inject({ method: 'GET', url: '/api/notifications' });
    await app.close();

    // This caught a real omission: the route had no `requireAuth` and so its
    // handler asked for a principal that was never loaded.
    expect(anonymous.statusCode).toBe(401);
  });

  it('returns a signed-in person’s own notifications', async () => {
    await container.notifications.notifyPortfolio({
      portfolioId,
      event: 'TEST',
      title: 'yours',
      body: 'body',
    });

    const app = await buildTestApp();
    const session = await login(app.app, 'ops@test.local');
    const response = await app.app.inject({
      method: 'GET',
      url: '/api/notifications',
      headers: session.headers(),
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect((response.json() as { notifications: unknown[] }).notifications).toHaveLength(1);
  });
});
