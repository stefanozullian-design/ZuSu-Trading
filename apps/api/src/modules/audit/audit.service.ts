import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { AuditAction, TradingEnvironment } from '@zusu/shared';
import { canonicalJson, redactDeep } from './redact.js';

export type ActorType = 'USER' | 'SYSTEM' | 'SCHEDULER' | 'BROKER_WEBHOOK';

export interface AuditInput {
  action: AuditAction | string;
  actorUserId?: string | null;
  actorType?: ActorType;
  actorLabel?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  portfolioId?: string | null;
  clientId?: string | null;
  correlationId?: string | null;
  environment?: TradingEnvironment | null;
  before?: unknown;
  after?: unknown;
  metadata?: Record<string, unknown> | null;
  ip?: string | null;
  userAgent?: string | null;
  sessionId?: string | null;
}

export type ChainVerification =
  | { valid: true; checked: number }
  | { valid: false; checked: number; brokenAtSeq: string; reason: string };

/** Postgres advisory-lock id; serialises appends so the chain stays linear. */
const AUDIT_CHAIN_LOCK = 0x2705a0d1;

/** Shape hashed for a row. Field order is irrelevant — the JSON is canonical. */
interface HashablePayload {
  action: string;
  actorUserId: string | null;
  actorType: string;
  actorLabel: string | null;
  entityType: string | null;
  entityId: string | null;
  portfolioId: string | null;
  clientId: string | null;
  correlationId: string | null;
  environment: string | null;
  beforeValue: unknown;
  afterValue: unknown;
  metadata: unknown;
  ip: string | null;
  userAgent: string | null;
  sessionId: string | null;
  occurredAt: string;
}

export function hashAuditPayload(prevHash: string | null, payload: HashablePayload): string {
  return createHash('sha256')
    .update(prevHash ?? 'GENESIS')
    .update(' ')
    .update(canonicalJson(payload))
    .digest('hex');
}

/**
 * Append-only audit log with a tamper-evident hash chain.
 *
 * Each row's hash covers the previous row's hash, so editing or removing a row
 * (which the database already refuses — see the `enforce_invariants` migration)
 * breaks every subsequent link. `verifyChain` detects that.
 */
export class AuditService {
  constructor(private readonly db: PrismaClient) {}

  async record(
    input: AuditInput,
    tx?: Prisma.TransactionClient,
  ): Promise<{ id: string; hash: string }> {
    if (tx) return this.append(tx, input);
    return this.db.$transaction((t) => this.append(t, input));
  }

  /**
   * Records without throwing. Used where a failed audit write must not mask the
   * original outcome — the error is handed to the caller's logger instead.
   */
  async recordSafe(input: AuditInput, onError?: (e: unknown) => void): Promise<void> {
    try {
      await this.record(input);
    } catch (err) {
      onError?.(err);
    }
  }

  private async append(
    tx: Prisma.TransactionClient,
    input: AuditInput,
  ): Promise<{ id: string; hash: string }> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${AUDIT_CHAIN_LOCK}::bigint)`;

    const previous = await tx.auditLog.findFirst({
      orderBy: { seq: 'desc' },
      select: { hash: true },
    });
    const prevHash = previous?.hash ?? null;

    const before = input.before === undefined ? null : redactDeep(input.before);
    const after = input.after === undefined ? null : redactDeep(input.after);
    const metadata = input.metadata ? redactDeep(input.metadata) : null;
    const occurredAt = new Date();

    const payload: HashablePayload = {
      action: String(input.action),
      actorUserId: input.actorUserId ?? null,
      actorType: input.actorType ?? 'USER',
      actorLabel: input.actorLabel ?? null,
      entityType: input.entityType ?? null,
      entityId: input.entityId ?? null,
      portfolioId: input.portfolioId ?? null,
      clientId: input.clientId ?? null,
      correlationId: input.correlationId ?? null,
      environment: input.environment ?? null,
      beforeValue: before,
      afterValue: after,
      metadata,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
      sessionId: input.sessionId ?? null,
      occurredAt: occurredAt.toISOString(),
    };

    return tx.auditLog.create({
      data: {
        occurredAt,
        actorUserId: input.actorUserId ?? null,
        actorType: payload.actorType,
        actorLabel: payload.actorLabel,
        action: payload.action,
        entityType: payload.entityType,
        entityId: payload.entityId,
        portfolioId: payload.portfolioId,
        clientId: payload.clientId,
        correlationId: payload.correlationId,
        environment: (input.environment ?? null) as TradingEnvironment | null,
        beforeValue: toJsonInput(before),
        afterValue: toJsonInput(after),
        metadata: toJsonInput(metadata),
        ip: payload.ip,
        userAgent: payload.userAgent,
        sessionId: payload.sessionId,
        prevHash,
        hash: hashAuditPayload(prevHash, payload),
      },
      select: { id: true, hash: true },
    });
  }

  /**
   * Recomputes the chain from the genesis row and reports the first link that
   * does not verify.
   */
  async verifyChain(limit = 10_000): Promise<ChainVerification> {
    const rows = await this.db.auditLog.findMany({ orderBy: { seq: 'asc' }, take: limit });
    let prevHash: string | null = null;
    let checked = 0;

    for (const row of rows) {
      checked += 1;
      if (row.prevHash !== prevHash) {
        return {
          valid: false,
          checked,
          brokenAtSeq: row.seq.toString(),
          reason: 'previous-hash link does not match the preceding row',
        };
      }
      const expected = hashAuditPayload(prevHash, {
        action: row.action,
        actorUserId: row.actorUserId,
        actorType: row.actorType,
        actorLabel: row.actorLabel,
        entityType: row.entityType,
        entityId: row.entityId,
        portfolioId: row.portfolioId,
        clientId: row.clientId,
        correlationId: row.correlationId,
        environment: row.environment,
        beforeValue: normaliseJson(row.beforeValue),
        afterValue: normaliseJson(row.afterValue),
        metadata: normaliseJson(row.metadata),
        ip: row.ip,
        userAgent: row.userAgent,
        sessionId: row.sessionId,
        occurredAt: row.occurredAt.toISOString(),
      });
      if (expected !== row.hash) {
        return {
          valid: false,
          checked,
          brokenAtSeq: row.seq.toString(),
          reason: 'row content does not match its recorded hash',
        };
      }
      prevHash = row.hash;
    }
    return { valid: true, checked };
  }
}

function toJsonInput(value: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return value === null || value === undefined ? Prisma.DbNull : (value as Prisma.InputJsonValue);
}

/** Prisma reads SQL NULL back as `null` and JSON null as `Prisma.JsonNull`. */
function normaliseJson(value: Prisma.JsonValue | null): unknown {
  return value === null || value === undefined ? null : value;
}
