import type { Prisma, PrismaClient } from '@prisma/client';
import { Permission } from '@zusu/shared';
import { AppError } from '../../lib/errors.js';
import type { AccessControl, Principal } from '../rbac/access-control.js';

/**
 * Notifications (§56).
 *
 * Only one channel is implemented: `BROWSER`, meaning a row this application
 * shows to the person when they next look. Push, email, SMS, Slack and Discord
 * exist in the schema and have no transport behind them — a notification
 * marked SENT that nothing sent would be worse than no notification at all, so
 * this service refuses any channel it cannot actually deliver.
 *
 * What gets a notification is deliberately narrow: things a person has to
 * decide, and things the platform refused to do. A stream of informational
 * noise trains people to ignore the one that matters.
 */

const DELIVERABLE_CHANNELS = ['BROWSER'] as const;
type DeliverableChannel = (typeof DELIVERABLE_CHANNELS)[number];

export interface NotificationView {
  id: string;
  event: string;
  title: string;
  body: string;
  status: string;
  channel: string;
  portfolioId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  sentAt: Date | null;
}

export class NotificationService {
  constructor(
    private readonly db: PrismaClient,
    private readonly access: AccessControl,
  ) {}

  /**
   * Records a notification for everyone who can see a portfolio.
   *
   * Best-effort by design: a failure to notify must never fail the thing being
   * notified about. A signal that was created and an order that was refused
   * both already have their own durable record.
   */
  async notifyPortfolio(input: {
    portfolioId: string;
    event: string;
    title: string;
    body: string;
    metadata?: Record<string, unknown>;
    channel?: DeliverableChannel;
  }): Promise<number> {
    const channel = input.channel ?? 'BROWSER';
    if (!DELIVERABLE_CHANNELS.includes(channel)) {
      throw new AppError(
        'NOT_IMPLEMENTED',
        `There is no transport for the ${channel} channel, so nothing would be sent.`,
      );
    }

    const [grants, portfolio] = await Promise.all([
      this.db.portfolioAccess.findMany({
        where: { portfolioId: input.portfolioId },
        select: { userId: true },
      }),
      this.db.portfolio.findUnique({
        where: { id: input.portfolioId },
        select: { clientId: true },
      }),
    ]);

    const userIds = new Set(grants.map((grant) => grant.userId));
    if (portfolio?.clientId) {
      const clientUsers = await this.db.user.findMany({
        where: { clientId: portfolio.clientId },
        select: { id: true },
      });
      for (const user of clientUsers) userIds.add(user.id);
    }

    if (userIds.size === 0) return 0;

    await this.db.notification.createMany({
      data: [...userIds].map((userId) => ({
        userId,
        portfolioId: input.portfolioId,
        channel,
        // A browser notification is delivered by being read, so it is SENT the
        // moment it is stored. Anything else would be a lie about a transport
        // that does not exist.
        status: 'SENT' as const,
        event: input.event,
        title: input.title,
        body: input.body,
        metadata: (input.metadata ?? null) as unknown as Prisma.InputJsonValue,
        sentAt: new Date(),
      })),
    });

    return userIds.size;
  }

  /** Records without throwing, for callers whose work must not depend on it. */
  async notifySafe(
    input: Parameters<NotificationService['notifyPortfolio']>[0],
    onError?: (error: unknown) => void,
  ): Promise<void> {
    try {
      await this.notifyPortfolio(input);
    } catch (error) {
      onError?.(error);
    }
  }

  async listFor(principal: Principal, limit = 30): Promise<NotificationView[]> {
    const rows = await this.db.notification.findMany({
      where: { userId: principal.id },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return rows.map(toView);
  }

  /** Marks one notification read by deleting it: an inbox, not an archive. */
  async dismiss(principal: Principal, id: string): Promise<void> {
    const row = await this.db.notification.findUnique({ where: { id } });
    if (!row) throw new AppError('NOT_FOUND', 'Notification not found');
    if (row.userId !== principal.id) {
      // Another person's inbox is not readable, so it is not dismissable
      // either — and the response says not found rather than confirming it
      // exists.
      throw new AppError('NOT_FOUND', 'Notification not found');
    }
    await this.db.notification.delete({ where: { id } });
  }

  /** Notifications across a portfolio, for an operator view. */
  async listForPortfolio(
    principal: Principal,
    portfolioId: string,
    limit = 50,
  ): Promise<NotificationView[]> {
    await this.access.assertPortfolioAccess(principal, portfolioId, {
      permission: Permission.PORTFOLIO_READ,
    });
    const rows = await this.db.notification.findMany({
      where: { portfolioId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return rows.map(toView);
  }
}

function toView(row: {
  id: string;
  event: string;
  title: string;
  body: string;
  status: string;
  channel: string;
  portfolioId: string | null;
  metadata: unknown;
  createdAt: Date;
  sentAt: Date | null;
}): NotificationView {
  return {
    id: row.id,
    event: row.event,
    title: row.title,
    body: row.body,
    status: row.status,
    channel: row.channel,
    portfolioId: row.portfolioId,
    metadata: (row.metadata ?? null) as Record<string, unknown> | null,
    createdAt: row.createdAt,
    sentAt: row.sentAt,
  };
}
