import { UserRole } from '@zusu/shared';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildContainer, type AppContainer } from '../../src/container.js';
import type { Principal } from '../../src/modules/rbac/access-control.js';
import { disconnectTestDb, resetDatabase, testDb } from '../helpers/db.js';
import { createPortfolio, createUser } from '../helpers/fixtures.js';

/**
 * The trade journal.
 *
 * The point of these tests is what the service refuses: it cannot overwrite a
 * thesis, and it cannot record the outcome of a position that is still open.
 * A journal edited after the result is known is a record of hindsight.
 */

const db = testDb();
let container: AppContainer;
let manager: Principal;
let portfolioId: string;
let positionId: string;
let entryId: string;

beforeEach(async () => {
  await resetDatabase();
  container ??= buildContainer({ db });

  const user = await createUser(db, { email: 'ops@test.local', role: UserRole.MANAGER });
  manager = { ...user };
  const portfolio = await createPortfolio(db, { name: 'Alpha' });
  portfolioId = portfolio.id;
  await db.portfolioAccess.create({
    data: { userId: user.id, portfolioId: portfolio.id, canTrade: true },
  });

  const position = await db.position.create({
    data: {
      portfolioId,
      symbol: 'AAPL',
      status: 'OPEN',
      quantity: '10',
      averageEntryPrice: '100',
      openedAt: new Date(),
    },
  });
  positionId = position.id;

  const entry = await db.tradeJournalEntry.create({
    data: {
      portfolioId,
      positionId,
      entryThesis: 'Oversold bounce above the 50-period average.',
      technicalContext: { rsi14: '28.4' },
    },
  });
  entryId = entry.id;
});

afterAll(async () => {
  await disconnectTestDb();
});

describe('notes', () => {
  it('appends rather than replacing, and stamps who wrote it', async () => {
    await container.journal.appendNote(manager, entryId, { note: 'Added on weakness.' });
    const entry = await container.journal.appendNote(manager, entryId, {
      note: 'Stop moved to break-even.',
    });

    expect(entry.userNotes).toContain('Added on weakness.');
    expect(entry.userNotes).toContain('Stop moved to break-even.');
    expect(entry.userNotes).toContain(manager.email);
    // The thesis captured at entry is untouched.
    expect(entry.entryThesis).toContain('Oversold bounce');
  });

  it('has no method that overwrites the thesis', () => {
    // Structural, not a promise: there is nothing to call.
    expect('updateThesis' in container.journal).toBe(false);
    expect('replaceNote' in container.journal).toBe(false);
  });

  it('refuses an empty note', async () => {
    await expect(container.journal.appendNote(manager, entryId, { note: ' ' })).rejects.toThrow(
      /Write something/,
    );
  });
});

describe('outcomes', () => {
  it('refuses to record an outcome while the position is open', async () => {
    await expect(
      container.journal.recordOutcome(manager, entryId, { outcome: 'Worked out nicely' }),
    ).rejects.toThrow(/still open/);
  });

  it('records the outcome and the lesson once the position is closed', async () => {
    await db.position.update({
      where: { id: positionId },
      data: { status: 'CLOSED', closedAt: new Date() },
    });

    const entry = await container.journal.recordOutcome(manager, entryId, {
      outcome: 'Closed at the target.',
      lessons: 'The entry was two bars early; waiting for the cross would have cost nothing.',
    });

    expect(entry.outcome).toBe('Closed at the target.');
    expect(entry.lessons).toContain('two bars early');
  });
});

describe('access', () => {
  it('refuses a caller with no access to the portfolio', async () => {
    const stranger = await createUser(db, { email: 'stranger@test.local', role: UserRole.MANAGER });
    await expect(container.journal.list({ ...stranger }, portfolioId)).rejects.toThrow(/not found/);
  });
});
