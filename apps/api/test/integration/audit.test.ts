import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditAction } from '@zusu/shared';
import { AuditService } from '../../src/modules/audit/audit.service.js';
import { disconnectTestDb, resetDatabase, testDb } from '../helpers/db.js';

const db = testDb();
const audit = new AuditService(db);

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await disconnectTestDb();
});

describe('audit log is append-only at the database level', () => {
  it('refuses UPDATE', async () => {
    const { id } = await audit.record({ action: AuditAction.LOGIN, actorType: 'SYSTEM' });
    await expect(
      db.$executeRawUnsafe(`UPDATE audit_logs SET action = 'TAMPERED' WHERE id = '${id}'`),
    ).rejects.toThrow(/append-only/i);

    const row = await db.auditLog.findUniqueOrThrow({ where: { id } });
    expect(row.action).toBe(AuditAction.LOGIN);
  });

  it('refuses DELETE', async () => {
    const { id } = await audit.record({ action: AuditAction.LOGIN, actorType: 'SYSTEM' });
    await expect(db.$executeRawUnsafe(`DELETE FROM audit_logs WHERE id = '${id}'`)).rejects.toThrow(
      /append-only/i,
    );
    expect(await db.auditLog.count()).toBe(1);
  });

  it('refuses TRUNCATE', async () => {
    await audit.record({ action: AuditAction.LOGIN, actorType: 'SYSTEM' });
    await expect(db.$executeRawUnsafe('TRUNCATE TABLE audit_logs')).rejects.toThrow(/append-only/i);
    expect(await db.auditLog.count()).toBe(1);
  });

  it('refuses a row without a proper hash', async () => {
    await expect(
      db.$executeRawUnsafe(
        `INSERT INTO audit_logs (id, action, hash) VALUES (gen_random_uuid(), 'FORGED', 'short')`,
      ),
    ).rejects.toThrow();
  });
});

describe('audit hash chain', () => {
  it('links every entry to its predecessor', async () => {
    for (let i = 0; i < 5; i += 1) {
      await audit.record({ action: AuditAction.LOGIN, actorType: 'SYSTEM', metadata: { i } });
    }

    const rows = await db.auditLog.findMany({ orderBy: { seq: 'asc' } });
    expect(rows[0]?.prevHash).toBeNull();
    for (let i = 1; i < rows.length; i += 1) {
      expect(rows[i]?.prevHash).toBe(rows[i - 1]?.hash);
    }

    const verification = await audit.verifyChain();
    expect(verification).toEqual({ valid: true, checked: 5 });
  });

  it('detects a row edited around the trigger', async () => {
    for (let i = 0; i < 3; i += 1) {
      await audit.record({ action: AuditAction.LOGIN, actorType: 'SYSTEM', metadata: { i } });
    }
    expect((await audit.verifyChain()).valid).toBe(true);

    // Simulates an attacker with enough database privilege to disable triggers.
    await db.$executeRawUnsafe('ALTER TABLE audit_logs DISABLE TRIGGER USER');
    await db.$executeRawUnsafe(
      `UPDATE audit_logs SET action = 'ORDER_FILLED' WHERE seq = (SELECT MIN(seq) FROM audit_logs)`,
    );
    await db.$executeRawUnsafe('ALTER TABLE audit_logs ENABLE TRIGGER USER');

    const verification = await audit.verifyChain();
    expect(verification.valid).toBe(false);
    if (!verification.valid) {
      expect(verification.reason).toMatch(/does not match its recorded hash/);
    }
  });

  it('detects a removed entry', async () => {
    for (let i = 0; i < 4; i += 1) {
      await audit.record({ action: AuditAction.LOGIN, actorType: 'SYSTEM', metadata: { i } });
    }

    await db.$executeRawUnsafe('ALTER TABLE audit_logs DISABLE TRIGGER USER');
    await db.$executeRawUnsafe(
      'DELETE FROM audit_logs WHERE seq = (SELECT MIN(seq) + 1 FROM audit_logs)',
    );
    await db.$executeRawUnsafe('ALTER TABLE audit_logs ENABLE TRIGGER USER');

    const verification = await audit.verifyChain();
    expect(verification.valid).toBe(false);
    if (!verification.valid) {
      expect(verification.reason).toMatch(/previous-hash link/);
    }
  });

  it('keeps the chain linear under concurrent writes', async () => {
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        audit.record({ action: AuditAction.LOGIN, actorType: 'SYSTEM', metadata: { i } }),
      ),
    );

    expect(await db.auditLog.count()).toBe(20);
    expect((await audit.verifyChain()).valid).toBe(true);
  });
});

describe('audit content', () => {
  it('strips secrets from before/after snapshots', async () => {
    await audit.record({
      action: AuditAction.BROKER_ACCOUNT_MODIFIED,
      actorType: 'SYSTEM',
      before: { label: 'old', credentials: { apiKey: 'super-secret-key' } },
      after: { label: 'new', credentials: { apiKey: 'another-secret' } },
      metadata: { password: 'hunter2' },
    });

    const row = await db.auditLog.findFirstOrThrow();
    // `seq` is a BigInt, which JSON.stringify refuses without a replacer.
    const serialised = JSON.stringify(row, (_key, value) =>
      typeof value === 'bigint' ? value.toString() : value,
    );
    expect(serialised).not.toContain('super-secret-key');
    expect(serialised).not.toContain('another-secret');
    expect(serialised).not.toContain('hunter2');
    expect(serialised).toContain('[redacted]');
    // Non-secret fields survive so the record stays useful.
    expect(serialised).toContain('"label":"old"');
  });

  it('rolls back the audit row when its transaction fails', async () => {
    await expect(
      db.$transaction(async (tx) => {
        await audit.record({ action: AuditAction.PORTFOLIO_CREATED, actorType: 'SYSTEM' }, tx);
        throw new Error('business rule failed');
      }),
    ).rejects.toThrow('business rule failed');

    expect(await db.auditLog.count()).toBe(0);
  });
});
