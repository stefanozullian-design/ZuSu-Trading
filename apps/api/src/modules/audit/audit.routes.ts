import type { Prisma } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { Permission, auditQuerySchema } from '@zusu/shared';
import type { AppContainer } from '../../container.js';
import { principalOf } from '../../plugins/auth.js';

const auditEntrySchema = z.object({
  seq: z.string(),
  id: z.string().uuid(),
  occurredAt: z.string().datetime(),
  action: z.string(),
  actorType: z.string(),
  actorUserId: z.string().uuid().nullable(),
  actorEmail: z.string().nullable(),
  entityType: z.string().nullable(),
  entityId: z.string().nullable(),
  portfolioId: z.string().uuid().nullable(),
  environment: z.string().nullable(),
  correlationId: z.string().nullable(),
  beforeValue: z.unknown().nullable(),
  afterValue: z.unknown().nullable(),
  metadata: z.unknown().nullable(),
  ip: z.string().nullable(),
  hash: z.string(),
});

export async function registerAuditRoutes(
  app: FastifyInstance,
  container: AppContainer,
): Promise<void> {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.get(
    '/',
    {
      preHandler: app.requirePermission(Permission.AUDIT_READ),
      schema: {
        tags: ['audit'],
        summary: 'Read the append-only audit log',
        querystring: auditQuerySchema,
        response: {
          200: z.object({
            entries: z.array(auditEntrySchema),
            nextCursor: z.string().nullable(),
          }),
        },
      },
    },
    async (request, reply) => {
      const principal = principalOf(request);
      const q = request.query;

      // Even an audit reader only sees rows for portfolios they may reach.
      const reachable = await container.access.listAccessiblePortfolioIds(principal);
      const scope: Prisma.AuditLogWhereInput =
        principal.role === 'ADMIN'
          ? {}
          : { OR: [{ portfolioId: null }, { portfolioId: { in: reachable } }] };

      const where: Prisma.AuditLogWhereInput = {
        AND: [
          scope,
          q.portfolioId ? { portfolioId: q.portfolioId } : {},
          q.action ? { action: q.action } : {},
          q.actorId ? { actorUserId: q.actorId } : {},
          q.from ? { occurredAt: { gte: new Date(q.from) } } : {},
          q.to ? { occurredAt: { lte: new Date(q.to) } } : {},
          q.cursor ? { seq: { lt: BigInt(q.cursor) } } : {},
        ],
      };

      const rows = await container.db.auditLog.findMany({
        where,
        orderBy: { seq: 'desc' },
        take: q.limit + 1,
        include: { actor: { select: { email: true } } },
      });

      const page = rows.slice(0, q.limit);
      return reply.send({
        entries: page.map((row) => ({
          seq: row.seq.toString(),
          id: row.id,
          occurredAt: row.occurredAt.toISOString(),
          action: row.action,
          actorType: row.actorType,
          actorUserId: row.actorUserId,
          actorEmail: row.actor?.email ?? null,
          entityType: row.entityType,
          entityId: row.entityId,
          portfolioId: row.portfolioId,
          environment: row.environment,
          correlationId: row.correlationId,
          beforeValue: row.beforeValue ?? null,
          afterValue: row.afterValue ?? null,
          metadata: row.metadata ?? null,
          ip: row.ip,
          hash: row.hash,
        })),
        nextCursor: rows.length > q.limit ? (page.at(-1)?.seq.toString() ?? null) : null,
      });
    },
  );

  typed.get(
    '/verify',
    {
      preHandler: app.requirePermission(Permission.AUDIT_READ),
      schema: {
        tags: ['audit'],
        summary: 'Recompute the audit hash chain and report any broken link',
        response: {
          200: z.object({
            valid: z.boolean(),
            checked: z.number().int(),
            brokenAtSeq: z.string().optional(),
            reason: z.string().optional(),
          }),
        },
      },
    },
    async (_request, reply) => reply.send(await container.audit.verifyChain()),
  );
}
