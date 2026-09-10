import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditAction, UserRole } from '@zusu/shared';
import { SecretBox } from '../../src/lib/crypto.js';
import { currentTotp, generateMfaSecret } from '../../src/modules/auth/mfa.js';
import { buildTestApp, login, sessionFromResponse, type TestApp } from '../helpers/app.js';
import { disconnectTestDb, resetDatabase, testDb } from '../helpers/db.js';
import { TEST_PASSWORD, createUser } from '../helpers/fixtures.js';

let harness: TestApp;
const db = testDb();

beforeEach(async () => {
  await resetDatabase();
  harness ??= await buildTestApp();
});

afterAll(async () => {
  await harness?.close();
  await disconnectTestDb();
});

describe('password login', () => {
  it('issues a session for correct credentials', async () => {
    await createUser(db, { email: 'manager@test.local', role: UserRole.MANAGER });

    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'manager@test.local', password: TEST_PASSWORD },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe('AUTHENTICATED');
    expect(body.user.role).toBe('MANAGER');
    expect(body.user).not.toHaveProperty('passwordHash');

    // The session tokens are httpOnly; only the CSRF token is readable.
    const names = response.cookies.map((c) => c.name);
    expect(names).toContain('zusu_at');
    expect(names).toContain('zusu_rt');
    expect(response.cookies.find((c) => c.name === 'zusu_at')?.httpOnly).toBe(true);
    expect(response.cookies.find((c) => c.name === 'zusu_csrf')?.httpOnly).toBeFalsy();
  });

  it('gives the same answer for a wrong password and an unknown account', async () => {
    await createUser(db, { email: 'real@test.local', role: UserRole.MANAGER });

    const wrongPassword = await harness.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'real@test.local', password: 'not-the-password' },
    });
    const unknownAccount = await harness.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'ghost@test.local', password: 'not-the-password' },
    });

    expect(wrongPassword.statusCode).toBe(401);
    expect(unknownAccount.statusCode).toBe(401);
    expect(wrongPassword.json().error.message).toBe(unknownAccount.json().error.message);
  });

  it('refuses a disabled account', async () => {
    await createUser(db, { email: 'gone@test.local', role: UserRole.MANAGER, isActive: false });
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'gone@test.local', password: TEST_PASSWORD },
    });
    expect(response.statusCode).toBe(401);
  });

  it('locks an account after repeated failures', async () => {
    await createUser(db, { email: 'target@test.local', role: UserRole.MANAGER });

    for (let attempt = 0; attempt < 8; attempt += 1) {
      await harness.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: 'target@test.local', password: `wrong-${attempt}` },
      });
    }

    // Even the correct password is refused while the lock stands.
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'target@test.local', password: TEST_PASSWORD },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.message).toMatch(/locked/i);
  });

  it('records every failed attempt in the audit log', async () => {
    await createUser(db, { email: 'audited@test.local', role: UserRole.MANAGER });
    await harness.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'audited@test.local', password: 'wrong' },
    });

    const entries = await db.auditLog.findMany({ where: { action: AuditAction.LOGIN_FAILED } });
    expect(entries).toHaveLength(1);
  });
});

describe('multi-factor authentication', () => {
  it('will not issue an administrator session without enrolment', async () => {
    await createUser(db, { email: 'admin@test.local', role: UserRole.ADMIN });

    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'admin@test.local', password: TEST_PASSWORD },
    });

    const body = response.json();
    expect(body.status).toBe('MFA_ENROLMENT_REQUIRED');
    expect(body.mfaToken).toBeTruthy();
    // No session cookie is set by a challenge.
    expect(response.cookies.map((c) => c.name)).not.toContain('zusu_at');
  });

  it('completes enrolment and then signs in with a code', async () => {
    const user = await createUser(db, { email: 'admin2@test.local', role: UserRole.ADMIN });

    const first = await harness.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'admin2@test.local', password: TEST_PASSWORD },
    });
    const { mfaToken } = first.json();

    const enrol = await harness.app.inject({
      method: 'POST',
      url: '/api/auth/mfa/enrol',
      payload: { mfaToken },
    });
    const { secret, otpauthUrl, qrDataUrl } = enrol.json();
    expect(otpauthUrl).toContain('otpauth://totp/');
    expect(qrDataUrl.startsWith('data:image/png;base64,')).toBe(true);

    // The secret is stored encrypted, never in the clear.
    const stored = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(stored.mfaSecret).not.toBe(secret);
    expect(stored.mfaSecret?.startsWith('v1:')).toBe(true);
    expect(stored.mfaEnabled).toBe(false);

    const verify = await harness.app.inject({
      method: 'POST',
      url: '/api/auth/mfa/verify',
      payload: { mfaToken, totp: currentTotp(secret) },
    });
    expect(verify.statusCode).toBe(200);
    expect(verify.cookies.map((c) => c.name)).toContain('zusu_at');
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).mfaEnabled).toBe(true);
  });

  it('demands a code from an enrolled user and rejects a wrong one', async () => {
    const secret = generateMfaSecret();
    const box = new SecretBox(process.env.CREDENTIAL_ENCRYPTION_KEY as string);
    const user = await createUser(db, { email: 'admin3@test.local', role: UserRole.ADMIN });
    await db.user.update({
      where: { id: user.id },
      data: { mfaEnabled: true, mfaSecret: box.encrypt(secret, user.id) },
    });

    const challenge = await harness.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'admin3@test.local', password: TEST_PASSWORD },
    });
    expect(challenge.json().status).toBe('MFA_REQUIRED');

    const wrong = await harness.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'admin3@test.local', password: TEST_PASSWORD, totp: '000000' },
    });
    expect(wrong.statusCode).toBe(401);

    const right = await harness.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'admin3@test.local', password: TEST_PASSWORD, totp: currentTotp(secret) },
    });
    expect(right.json().status).toBe('AUTHENTICATED');
  });
});

describe('refresh tokens', () => {
  it('rotates the refresh token on every use', async () => {
    await createUser(db, { email: 'rotate@test.local', role: UserRole.MANAGER });
    const session = await login(harness.app, 'rotate@test.local');

    const refreshed = await harness.app.inject({
      method: 'POST',
      url: '/api/auth/refresh',
      headers: { cookie: session.cookies },
    });

    expect(refreshed.statusCode).toBe(200);
    const newRefresh = refreshed.cookies.find((c) => c.name === 'zusu_rt')?.value;
    expect(newRefresh).toBeTruthy();
    expect(session.cookies).not.toContain(newRefresh as string);

    const tokens = await db.refreshToken.findMany({ orderBy: { issuedAt: 'asc' } });
    expect(tokens).toHaveLength(2);
    expect(tokens[0]?.revokedAt).not.toBeNull();
    expect(tokens[0]?.replacedById).toBe(tokens[1]?.id);
  });

  it('treats reuse of a rotated token as theft and kills the family', async () => {
    await createUser(db, { email: 'reuse@test.local', role: UserRole.MANAGER });
    const session = await login(harness.app, 'reuse@test.local');

    const rotated = await harness.app.inject({
      method: 'POST',
      url: '/api/auth/refresh',
      headers: { cookie: session.cookies },
    });
    const freshSession = sessionFromResponse(rotated.cookies, rotated.json().csrfToken);

    // Replaying the original (already rotated) token.
    const replay = await harness.app.inject({
      method: 'POST',
      url: '/api/auth/refresh',
      headers: { cookie: session.cookies },
    });
    expect(replay.statusCode).toBe(401);

    const reuse = await db.auditLog.findFirst({
      where: { action: AuditAction.TOKEN_REUSE_DETECTED },
    });
    expect(reuse).not.toBeNull();

    // The attacker's replay also invalidates the legitimate holder's token.
    const afterRevocation = await harness.app.inject({
      method: 'POST',
      url: '/api/auth/refresh',
      headers: { cookie: freshSession.cookies },
    });
    expect(afterRevocation.statusCode).toBe(401);
    expect(await db.refreshToken.count({ where: { revokedAt: null } })).toBe(0);
  });

  it('ends the session on logout', async () => {
    await createUser(db, { email: 'bye@test.local', role: UserRole.MANAGER });
    const session = await login(harness.app, 'bye@test.local');

    const logout = await harness.app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: session.headers(),
    });
    expect(logout.statusCode).toBe(200);

    const refresh = await harness.app.inject({
      method: 'POST',
      url: '/api/auth/refresh',
      headers: { cookie: session.cookies },
    });
    expect(refresh.statusCode).toBe(401);
  });
});

describe('session enforcement', () => {
  it('rejects an unauthenticated request', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/api/portfolios' });
    expect(response.statusCode).toBe(401);
  });

  it('rejects a forged access token', async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/portfolios',
      headers: { cookie: 'zusu_at=not.a.real.token' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('stops honouring a session as soon as the account is disabled', async () => {
    const user = await createUser(db, { email: 'revoked@test.local', role: UserRole.MANAGER });
    const session = await login(harness.app, 'revoked@test.local');
    expect(
      (
        await harness.app.inject({
          method: 'GET',
          url: '/api/auth/me',
          headers: { cookie: session.cookies },
        })
      ).statusCode,
    ).toBe(200);

    await db.user.update({ where: { id: user.id }, data: { isActive: false } });

    const after = await harness.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: session.cookies },
    });
    expect(after.statusCode).toBe(401);
  });

  it('requires a CSRF token on state-changing requests', async () => {
    await createUser(db, { email: 'csrf@test.local', role: UserRole.MANAGER });
    const session = await login(harness.app, 'csrf@test.local');

    const withoutToken = await harness.app.inject({
      method: 'POST',
      url: '/api/risk/kill-switch',
      headers: { cookie: session.cookies },
      payload: { reason: 'testing csrf' },
    });
    expect(withoutToken.statusCode).toBe(403);

    const mismatched = await harness.app.inject({
      method: 'POST',
      url: '/api/risk/kill-switch',
      headers: { cookie: session.cookies, 'x-csrf-token': 'wrong-token-value' },
      payload: { reason: 'testing csrf' },
    });
    expect(mismatched.statusCode).toBe(403);
  });
});
