import type { PrismaClient } from '@prisma/client';
import type { Finding } from '@zusu/shared';
import type { NotificationService } from '../notifications/notification.service.js';
import type { Principal } from '../rbac/access-control.js';
import type { CompositionService } from './composition.service.js';

/**
 * The watcher: notices things, and says so once.
 *
 * "Watch and tell" rather than "ask and be told". Nobody opens a portfolio
 * tool to discover that a sector quietly grew past its limit three weeks ago —
 * by then the question is what to do about it, not whether it happened.
 *
 * Three properties decide whether a thing like this is useful or ignored:
 *
 *   - **It reports transitions, not states.** Re-announcing the same
 *     concentration every hour is how a person learns to skip the whole
 *     channel, and the cost of that is the one message that was new. Each
 *     finding is remembered, and a notification goes out when it appears and
 *     when it clears — never on the quiet runs between.
 *
 *   - **It reports clearing too.** "Technology is back under its limit" is as
 *     useful as the breach was. A watcher that only ever brings bad news
 *     leaves a person unable to tell a fixed problem from an unwatched one.
 *
 *   - **It uses the same findings the screen shows.** Not a second
 *     implementation with its own thresholds: a concentration the dashboard
 *     calls fine while an alert calls it a breach destroys trust in both.
 *
 * Informational findings are recorded and never notified. "This sector is not
 * recorded" is worth seeing when you look; it is not worth interrupting
 * anybody for, and a channel that carries it will not be read when something
 * matters.
 */

/** Only these are worth interrupting someone for. */
const NOTIFIABLE = new Set(['BREACH', 'WATCH']);

export interface WatchOutcome {
  portfolioId: string;
  appeared: Finding[];
  cleared: { code: string; subject: string | null; title: string }[];
  /** Still true since an earlier run. Deliberately not notified again. */
  unchanged: number;
  /** Set when the portfolio could not be read at all. */
  error: string | null;
}

export class WatcherService {
  constructor(
    private readonly db: PrismaClient,
    private readonly composition: CompositionService,
    private readonly notifications: NotificationService,
  ) {}

  /**
   * Runs the watcher over every active portfolio.
   *
   * One portfolio failing must not stop the rest: the watcher runs unattended,
   * and a single unreadable book would otherwise silence every other one until
   * somebody noticed.
   */
  async runAll(): Promise<WatchOutcome[]> {
    const portfolios = await this.db.portfolio.findMany({
      where: { isActive: true },
      select: { id: true },
    });

    const outcomes: WatchOutcome[] = [];
    for (const portfolio of portfolios) {
      try {
        outcomes.push(await this.run(portfolio.id));
      } catch (error) {
        outcomes.push({
          portfolioId: portfolio.id,
          appeared: [],
          cleared: [],
          unchanged: 0,
          error: error instanceof Error ? error.message : 'could not be read',
        });
      }
    }
    return outcomes;
  }

  async run(portfolioId: string): Promise<WatchOutcome> {
    // The watcher acts on its own behalf, not a person's. It reads every
    // portfolio because that is its job; what it may *say*, and to whom, is
    // decided by the notification service from who can see the portfolio.
    const view = await this.composition.forPortfolio(WATCHER, portfolioId);
    const now = new Date();

    const current = new Map(view.findings.map((finding) => [keyOf(finding), finding]));

    // Every row, resolved or not. A finding that cleared last week and is back
    // today has a row already, and inserting a second would break the identity
    // index — and, worse, would make it look new forever.
    const stored = await this.db.portfolioFinding.findMany({ where: { portfolioId } });
    const storedByKey = new Map(stored.map((row) => [`${row.code}:${row.subject ?? ''}`, row]));

    const appeared: Finding[] = [];
    let unchanged = 0;

    for (const [key, finding] of current) {
      const existing = storedByKey.get(key);
      const shared = {
        severity: finding.severity,
        title: finding.title,
        detail: finding.detail,
        lastSeenAt: now,
      };

      if (existing && existing.resolvedAt === null) {
        // Still true. The wording may have drifted with the weight — 33.6% to
        // 34.1% — and that is the same finding, so the text is refreshed and
        // nobody is told a second time.
        unchanged += 1;
        await this.db.portfolioFinding.update({ where: { id: existing.id }, data: shared });
        continue;
      }

      appeared.push(finding);
      if (existing) {
        // Back again after clearing. Its first-seen date restarts, because the
        // question a reader asks is how long *this* episode has been true.
        await this.db.portfolioFinding.update({
          where: { id: existing.id },
          data: { ...shared, firstSeenAt: now, resolvedAt: null, notifiedAt: null },
        });
      } else {
        await this.db.portfolioFinding.create({
          data: {
            portfolioId,
            code: finding.code,
            subject: finding.subject ?? null,
            ...shared,
            firstSeenAt: now,
          },
        });
      }
    }

    const cleared: WatchOutcome['cleared'] = [];
    for (const [key, row] of storedByKey) {
      if (current.has(key) || row.resolvedAt !== null) continue;
      cleared.push({ code: row.code, subject: row.subject, title: row.title });
      await this.db.portfolioFinding.update({
        where: { id: row.id },
        data: { resolvedAt: now },
      });
    }

    await this.tell(portfolioId, appeared, cleared, now);

    return { portfolioId, appeared, cleared, unchanged, error: null };
  }

  private async tell(
    portfolioId: string,
    appeared: Finding[],
    cleared: WatchOutcome['cleared'],
    now: Date,
  ): Promise<void> {
    const worthSaying = appeared.filter((f) => NOTIFIABLE.has(f.severity));

    for (const finding of worthSaying) {
      await this.notifications.notifyPortfolio({
        portfolioId,
        event: 'PORTFOLIO_FINDING',
        title: finding.title,
        body: finding.detail,
        metadata: {
          code: finding.code,
          severity: finding.severity,
          ...(finding.subject === undefined ? {} : { subject: finding.subject }),
        },
      });
      await this.db.portfolioFinding.updateMany({
        where: { portfolioId, code: finding.code, subject: finding.subject ?? null },
        data: { notifiedAt: now },
      });
    }

    for (const gone of cleared) {
      await this.notifications.notifyPortfolio({
        portfolioId,
        event: 'PORTFOLIO_FINDING_CLEARED',
        title: `Cleared: ${gone.title}`,
        body:
          'This is no longer true. Nothing was done to the portfolio by this platform — either ' +
          'you acted, or prices moved.',
        metadata: { code: gone.code, ...(gone.subject === null ? {} : { subject: gone.subject }) },
      });
    }
  }
}

/**
 * The watcher's own identity.
 *
 * It reads every portfolio because that is its job, and it holds no human's
 * permissions. What it may say, and to whom, is decided downstream by the
 * notification service from who can see the portfolio — so widening this does
 * not widen who hears about it.
 */
const WATCHER: Principal = {
  id: '00000000-0000-4000-8000-000000000001',
  role: 'ADMIN',
  clientId: null,
  email: 'watcher@zusu.local',
  isActive: true,
} as Principal;

function keyOf(finding: Finding): string {
  return `${finding.code}:${finding.subject ?? ''}`;
}
