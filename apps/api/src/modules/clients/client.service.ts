import type { PrismaClient } from '@prisma/client';
import { AuditAction, Permission, type UpdateClientInput } from '@zusu/shared';
import { AppError } from '../../lib/errors.js';
import type { AuditService } from '../audit/audit.service.js';
import type { AccessControl, Principal } from '../rbac/access-control.js';

export interface ClientDto {
  id: string;
  name: string;
  externalRef: string | null;
  contactEmail: string | null;
  isActive: boolean;
  portfolioCount: number;
  createdAt: string;
}

export class ClientService {
  constructor(
    private readonly db: PrismaClient,
    private readonly access: AccessControl,
    private readonly audit: AuditService,
  ) {}

  /**
   * Clients are only ever listed for principals that may read client records.
   * A CLIENT-role user never reaches this endpoint — they see their own
   * portfolios, not the client roster (§41).
   */
  async list(
    principal: Principal,
    options: { includeInactive?: boolean } = {},
  ): Promise<ClientDto[]> {
    this.access.assertPermission(principal, Permission.CLIENT_READ);
    const clients = await this.db.client.findMany({
      // Retired owners are out of the pickers by default — that is what
      // retiring one is for — and back in view for anyone managing the roster.
      where: options.includeInactive ? {} : { isActive: true },
      orderBy: { name: 'asc' },
      include: { _count: { select: { ownedPortfolios: true } } },
    });
    return clients.map((c) => ({
      id: c.id,
      name: c.name,
      externalRef: c.externalRef,
      contactEmail: c.contactEmail,
      isActive: c.isActive,
      portfolioCount: c._count.ownedPortfolios,
      createdAt: c.createdAt.toISOString(),
    }));
  }

  async create(
    principal: Principal,
    input: { name: string; externalRef?: string; contactEmail?: string; notes?: string },
  ): Promise<ClientDto> {
    this.access.assertPermission(principal, Permission.CLIENT_WRITE);

    const client = await this.db.$transaction(async (tx) => {
      const created = await tx.client.create({
        data: {
          name: input.name,
          externalRef: input.externalRef ?? null,
          contactEmail: input.contactEmail ?? null,
          notes: input.notes ?? null,
        },
      });
      await this.audit.record(
        {
          action: AuditAction.CLIENT_CREATED,
          actorUserId: principal.id,
          entityType: 'Client',
          entityId: created.id,
          clientId: created.id,
          after: { name: created.name, externalRef: created.externalRef },
        },
        tx,
      );
      return created;
    });

    return {
      id: client.id,
      name: client.name,
      externalRef: client.externalRef,
      contactEmail: client.contactEmail,
      isActive: client.isActive,
      portfolioCount: 0,
      createdAt: client.createdAt.toISOString(),
    };
  }

  /**
   * Editing an owner: a name, a contact, a reference, or retiring them.
   *
   * Retiring rather than deleting, for the same reason a portfolio is closed
   * rather than deleted: an owner is referenced by append-only audit rows from
   * the moment they exist, and erasing one would mean rewriting a record the
   * database refuses to rewrite. A retired owner leaves every picker and keeps
   * their history.
   */
  async update(
    principal: Principal,
    clientId: string,
    patch: UpdateClientInput,
  ): Promise<ClientDto> {
    this.access.assertPermission(principal, Permission.CLIENT_WRITE);

    const before = await this.db.client.findUnique({
      where: { id: clientId },
      include: { _count: { select: { ownedPortfolios: true } } },
    });
    if (!before) throw new AppError('NOT_FOUND', 'Owner not found');

    // Retiring somebody who still owns open portfolios would take them out of
    // every picker while their money is still being traded — a book nobody is
    // filtering to and nobody is watching.
    if (patch.isActive === false && before.isActive) {
      const open = await this.db.portfolio.count({ where: { clientId, isActive: true } });
      if (open > 0) {
        throw new AppError(
          'CONFLICT',
          `${before.name} still owns ${String(open)} open portfolio(s). Close them or move ` +
            'them to another owner first — retiring somebody whose money is still being ' +
            'traded hides the book rather than the person.',
        );
      }
    }

    const updated = await this.db.$transaction(async (tx) => {
      const next = await tx.client.update({
        where: { id: clientId },
        data: {
          ...(patch.name === undefined ? {} : { name: patch.name }),
          ...(patch.externalRef === undefined ? {} : { externalRef: patch.externalRef }),
          ...(patch.contactEmail === undefined ? {} : { contactEmail: patch.contactEmail }),
          ...(patch.notes === undefined ? {} : { notes: patch.notes }),
          ...(patch.isActive === undefined ? {} : { isActive: patch.isActive }),
        },
        include: { _count: { select: { ownedPortfolios: true } } },
      });

      await this.audit.record(
        {
          action: AuditAction.CLIENT_MODIFIED,
          actorUserId: principal.id,
          entityType: 'Client',
          entityId: clientId,
          clientId,
          before: {
            name: before.name,
            externalRef: before.externalRef,
            contactEmail: before.contactEmail,
            isActive: before.isActive,
          },
          after: {
            name: next.name,
            externalRef: next.externalRef,
            contactEmail: next.contactEmail,
            isActive: next.isActive,
          },
        },
        tx,
      );
      return next;
    });

    return {
      id: updated.id,
      name: updated.name,
      externalRef: updated.externalRef,
      contactEmail: updated.contactEmail,
      isActive: updated.isActive,
      portfolioCount: updated._count.ownedPortfolios,
      createdAt: updated.createdAt.toISOString(),
    };
  }

  /**
   * Why there is no delete.
   *
   * Every audit row an owner appears in is append-only and enforced by a
   * database trigger. Removing the owner would leave rows pointing at nothing,
   * or require rewriting them, and a trading record that can be rewritten is
   * not a record. Retiring does what people actually want from "delete" when
   * they added somebody by mistake.
   */
  static readonly deletionIsNotOffered =
    'An owner is referenced by append-only audit rows from the moment they exist. ' +
    'Retire them instead: they leave every picker and their history stays intact.';
}
