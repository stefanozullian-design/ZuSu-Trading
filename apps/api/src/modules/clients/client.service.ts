import type { PrismaClient } from '@prisma/client';
import { AuditAction, Permission } from '@zusu/shared';
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
  async list(principal: Principal): Promise<ClientDto[]> {
    this.access.assertPermission(principal, Permission.CLIENT_READ);
    const clients = await this.db.client.findMany({
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
}
