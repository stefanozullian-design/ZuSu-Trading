import type { PrismaClient } from '@prisma/client';
import { Permission } from '@zusu/shared';
import { AppError } from '../../lib/errors.js';
import type { AccessControl, Principal } from '../rbac/access-control.js';

/**
 * The trade journal (§69).
 *
 * Two rules, and both are about the order in which things are written:
 *
 *   1. **The thesis is captured at entry, by the system.** A journal a person
 *      fills in later is a journal written after the outcome is known, which
 *      is a record of hindsight rather than of reasoning. The entry exists
 *      the moment a position opens, with the price, the order and the signal
 *      that produced it.
 *
 *   2. **A note is appended, never overwritten.** Each addition is stamped and
 *      added to what is already there. Editing a thesis after a loss is how a
 *      journal stops being evidence, so this service has no method for it.
 */

export interface JournalEntryView {
  id: string;
  portfolioId: string;
  positionId: string | null;
  signalId: string | null;
  symbol: string | null;
  entryThesis: string | null;
  technicalContext: Record<string, unknown> | null;
  aiReasoning: string | null;
  outcome: string | null;
  lessons: string | null;
  userNotes: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export class JournalService {
  constructor(
    private readonly db: PrismaClient,
    private readonly access: AccessControl,
  ) {}

  async list(principal: Principal, portfolioId: string, limit = 50): Promise<JournalEntryView[]> {
    await this.access.assertPortfolioAccess(principal, portfolioId, {
      permission: Permission.PORTFOLIO_READ,
    });

    const rows = await this.db.tradeJournalEntry.findMany({
      where: { portfolioId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: { position: { select: { symbol: true } } },
    });

    return rows.map((row) => ({
      id: row.id,
      portfolioId: row.portfolioId,
      positionId: row.positionId,
      signalId: row.signalId,
      symbol: row.position?.symbol ?? null,
      entryThesis: row.entryThesis,
      technicalContext: (row.technicalContext ?? null) as Record<string, unknown> | null,
      aiReasoning: row.aiReasoning,
      outcome: row.outcome,
      lessons: row.lessons,
      userNotes: row.userNotes,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));
  }

  /**
   * Appends a note to an entry.
   *
   * Appends: the existing text is kept and the new note is added under a
   * timestamp. There is deliberately no way through this service to replace
   * what was written before the outcome was known.
   */
  async appendNote(
    principal: Principal,
    entryId: string,
    input: { note: string; at?: Date },
  ): Promise<JournalEntryView> {
    const entry = await this.db.tradeJournalEntry.findUnique({ where: { id: entryId } });
    if (!entry) throw new AppError('NOT_FOUND', 'Journal entry not found');

    await this.access.assertPortfolioAccess(principal, entry.portfolioId, {
      permission: Permission.PORTFOLIO_WRITE,
    });

    const note = input.note.trim();
    if (note.length < 2) throw new AppError('VALIDATION_FAILED', 'Write something');

    const stamp = (input.at ?? new Date()).toISOString();
    const line = `[${stamp} · ${principal.email}] ${note}`;
    const userNotes = entry.userNotes ? `${entry.userNotes}\n${line}` : line;

    await this.db.tradeJournalEntry.update({
      where: { id: entryId },
      data: { userNotes },
    });

    const rows = await this.list(principal, entry.portfolioId, 200);
    const updated = rows.find((row) => row.id === entryId);
    if (!updated) throw new AppError('INTERNAL', 'The entry disappeared while being updated');
    return updated;
  }

  /**
   * Records how a trade turned out.
   *
   * Separate from the thesis, and written once the position is closed: the
   * outcome and the lesson belong to a different moment than the reasoning,
   * and keeping them apart is what makes the pair worth reading later.
   */
  async recordOutcome(
    principal: Principal,
    entryId: string,
    input: { outcome: string; lessons?: string },
  ): Promise<JournalEntryView> {
    const entry = await this.db.tradeJournalEntry.findUnique({
      where: { id: entryId },
      include: { position: true },
    });
    if (!entry) throw new AppError('NOT_FOUND', 'Journal entry not found');

    await this.access.assertPortfolioAccess(principal, entry.portfolioId, {
      permission: Permission.PORTFOLIO_WRITE,
    });

    if (entry.position && entry.position.status !== 'CLOSED') {
      throw new AppError(
        'CONFLICT',
        'This position is still open, so its outcome is not known yet. ' +
          'Add a note instead — an outcome recorded early is a prediction.',
      );
    }

    await this.db.tradeJournalEntry.update({
      where: { id: entryId },
      data: {
        outcome: input.outcome.trim(),
        ...(input.lessons ? { lessons: input.lessons.trim() } : {}),
      },
    });

    const rows = await this.list(principal, entry.portfolioId, 200);
    const updated = rows.find((row) => row.id === entryId);
    if (!updated) throw new AppError('INTERNAL', 'The entry disappeared while being updated');
    return updated;
  }
}
