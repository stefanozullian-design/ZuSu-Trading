import type { PrismaClient, User } from '@prisma/client';
import {
  AuditAction,
  UserRole,
  permissionsForRole,
  roleRequiresMfa,
  type AuthenticatedUser,
} from '@zusu/shared';
import { config } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';
import {
  SecretBox,
  generateOpaqueToken,
  hashPassword,
  randomUUID,
  sha256,
  verifyPassword,
} from '../../lib/crypto.js';
import type { AuditService } from '../audit/audit.service.js';
import { buildOtpauthUrl, buildQrDataUrl, generateMfaSecret, verifyTotp } from './mfa.js';
import { signAccessToken, signMfaChallengeToken, verifyMfaChallengeToken } from './tokens.js';

const MAX_FAILED_LOGINS = 8;
const LOCKOUT_MINUTES = 15;

/**
 * A hash of a value nobody knows, compared against when the email does not
 * exist so that "unknown user" and "wrong password" take the same time.
 */
const DUMMY_HASH_PROMISE = hashPassword(generateOpaqueToken(32));

export interface RequestContext {
  ip?: string | null;
  userAgent?: string | null;
}

export interface IssuedSession {
  user: AuthenticatedUser;
  accessToken: string;
  accessTokenExpiresAt: Date;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
  csrfToken: string;
  sessionId: string;
}

export type LoginOutcome =
  | { status: 'AUTHENTICATED'; session: IssuedSession }
  | { status: 'MFA_REQUIRED'; mfaToken: string }
  | { status: 'MFA_ENROLMENT_REQUIRED'; mfaToken: string };

export class AuthService {
  private readonly secretBox: SecretBox;

  constructor(
    private readonly db: PrismaClient,
    private readonly audit: AuditService,
  ) {
    this.secretBox = new SecretBox(config().CREDENTIAL_ENCRYPTION_KEY);
  }

  // -------------------------------------------------------------------------
  // Login
  // -------------------------------------------------------------------------

  async login(
    email: string,
    password: string,
    totp: string | undefined,
    ctx: RequestContext,
  ): Promise<LoginOutcome> {
    const normalisedEmail = email.trim().toLowerCase();
    const user = await this.db.user.findUnique({ where: { email: normalisedEmail } });

    if (!user) {
      // Burn the same work as a real verification before failing.
      await verifyPassword(password, await DUMMY_HASH_PROMISE);
      await this.audit.recordSafe({
        action: AuditAction.LOGIN_FAILED,
        actorType: 'SYSTEM',
        actorLabel: normalisedEmail,
        metadata: { reason: 'unknown-account' },
        ip: ctx.ip ?? null,
        userAgent: ctx.userAgent ?? null,
      });
      throw new AppError('UNAUTHENTICATED', 'Email or password is incorrect');
    }

    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw new AppError(
        'UNAUTHENTICATED',
        'This account is temporarily locked after repeated failed sign-ins. Try again later.',
      );
    }

    if (!user.isActive) {
      await this.recordFailure(user, ctx, 'account-disabled');
      throw new AppError('UNAUTHENTICATED', 'Email or password is incorrect');
    }

    if (!(await verifyPassword(password, user.passwordHash))) {
      await this.registerFailedLogin(user, ctx);
      throw new AppError('UNAUTHENTICATED', 'Email or password is incorrect');
    }

    if (user.failedLogins > 0 || user.lockedUntil) {
      await this.db.user.update({
        where: { id: user.id },
        data: { failedLogins: 0, lockedUntil: null },
      });
    }

    const mfaMandatory = roleRequiresMfa(user.role as UserRole);

    if (!user.mfaEnabled && mfaMandatory) {
      return {
        status: 'MFA_ENROLMENT_REQUIRED',
        mfaToken: await signMfaChallengeToken(user.id, 'ENROL'),
      };
    }

    if (user.mfaEnabled) {
      if (!totp) {
        return { status: 'MFA_REQUIRED', mfaToken: await signMfaChallengeToken(user.id, 'VERIFY') };
      }
      if (!this.checkTotp(user, totp)) {
        await this.recordFailure(user, ctx, 'totp-invalid', AuditAction.MFA_CHALLENGE_FAILED);
        throw new AppError('UNAUTHENTICATED', 'Authenticator code is incorrect');
      }
    }

    return { status: 'AUTHENTICATED', session: await this.issueSession(user, ctx) };
  }

  /** Second step of a login that required MFA, and the final step of enrolment. */
  async completeMfaChallenge(
    mfaToken: string,
    totp: string,
    ctx: RequestContext,
  ): Promise<IssuedSession> {
    const { userId, purpose } = await verifyMfaChallengeToken(mfaToken);
    const user = await this.db.user.findUnique({ where: { id: userId } });
    if (!user || !user.isActive) throw new AppError('UNAUTHENTICATED', 'Account is unavailable');

    if (!this.checkTotp(user, totp)) {
      await this.recordFailure(user, ctx, 'totp-invalid', AuditAction.MFA_CHALLENGE_FAILED);
      throw new AppError('UNAUTHENTICATED', 'Authenticator code is incorrect');
    }

    if (purpose === 'ENROL') {
      if (user.mfaEnabled)
        throw new AppError('CONFLICT', 'Multi-factor authentication is already active');
      await this.db.user.update({
        where: { id: user.id },
        data: { mfaEnabled: true, mfaEnrolledAt: new Date() },
      });
      await this.audit.recordSafe({
        action: AuditAction.MFA_ENROLLED,
        actorUserId: user.id,
        entityType: 'User',
        entityId: user.id,
        ip: ctx.ip ?? null,
        userAgent: ctx.userAgent ?? null,
      });
    }

    return this.issueSession({ ...user, mfaEnabled: true }, ctx);
  }

  /**
   * Starts enrolment: generates a secret, stores it encrypted, and hands back
   * the provisioning URI. MFA is not active until a code is verified.
   */
  async beginMfaEnrolment(
    userId: string,
  ): Promise<{ secret: string; otpauthUrl: string; qrDataUrl: string }> {
    const user = await this.db.user.findUnique({ where: { id: userId } });
    if (!user) throw new AppError('NOT_FOUND', 'User not found');
    if (user.mfaEnabled) {
      throw new AppError('CONFLICT', 'Multi-factor authentication is already active');
    }

    const secret = generateMfaSecret();
    await this.db.user.update({
      where: { id: user.id },
      data: { mfaSecret: this.secretBox.encrypt(secret, user.id), mfaEnabled: false },
    });

    const otpauthUrl = buildOtpauthUrl(user.email, secret);
    return { secret, otpauthUrl, qrDataUrl: await buildQrDataUrl(otpauthUrl) };
  }

  /** Same as `beginMfaEnrolment` but authorised by an MFA challenge token. */
  async beginMfaEnrolmentWithChallenge(mfaToken: string) {
    const { userId, purpose } = await verifyMfaChallengeToken(mfaToken);
    if (purpose !== 'ENROL') {
      throw new AppError('UNAUTHENTICATED', 'This challenge cannot be used for enrolment');
    }
    return this.beginMfaEnrolment(userId);
  }

  // -------------------------------------------------------------------------
  // Sessions
  // -------------------------------------------------------------------------

  private async issueSession(user: User, ctx: RequestContext): Promise<IssuedSession> {
    const sessionId = randomUUID();
    const refreshToken = generateOpaqueToken();
    const cfg = config();
    const refreshTokenExpiresAt = new Date(Date.now() + cfg.REFRESH_TOKEN_TTL_SECONDS * 1000);

    await this.db.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: sha256(refreshToken),
        familyId: sessionId,
        expiresAt: refreshTokenExpiresAt,
        ip: ctx.ip ?? null,
        userAgent: ctx.userAgent ?? null,
      },
    });

    const { token: accessToken, expiresAt: accessTokenExpiresAt } = await signAccessToken({
      userId: user.id,
      role: user.role as UserRole,
      sessionId,
      mfaSatisfied: user.mfaEnabled,
    });

    await this.db.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    await this.audit.recordSafe({
      action: AuditAction.LOGIN,
      actorUserId: user.id,
      entityType: 'User',
      entityId: user.id,
      sessionId,
      metadata: { role: user.role, mfa: user.mfaEnabled },
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent ?? null,
    });

    return {
      user: await this.describeUser(user),
      accessToken,
      accessTokenExpiresAt,
      refreshToken,
      refreshTokenExpiresAt,
      csrfToken: generateOpaqueToken(24),
      sessionId,
    };
  }

  /**
   * Rotates a refresh token. Presenting a token that was already rotated is
   * treated as theft: the whole family is revoked and the event is audited.
   */
  async refresh(refreshToken: string, ctx: RequestContext): Promise<IssuedSession> {
    const tokenHash = sha256(refreshToken);
    const existing = await this.db.refreshToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    });

    if (!existing)
      throw new AppError('UNAUTHENTICATED', 'Session has expired, please sign in again');

    if (existing.revokedAt) {
      await this.revokeFamily(existing.familyId, 'token-reuse-detected');
      await this.audit.recordSafe({
        action: AuditAction.TOKEN_REUSE_DETECTED,
        actorUserId: existing.userId,
        entityType: 'RefreshToken',
        entityId: existing.id,
        sessionId: existing.familyId,
        metadata: { revokedFamily: true },
        ip: ctx.ip ?? null,
        userAgent: ctx.userAgent ?? null,
      });
      throw new AppError('UNAUTHENTICATED', 'Session has been revoked, please sign in again');
    }

    if (existing.expiresAt <= new Date()) {
      throw new AppError('UNAUTHENTICATED', 'Session has expired, please sign in again');
    }
    if (!existing.user.isActive) throw new AppError('UNAUTHENTICATED', 'Account is unavailable');

    const cfg = config();
    const nextToken = generateOpaqueToken();
    const refreshTokenExpiresAt = new Date(Date.now() + cfg.REFRESH_TOKEN_TTL_SECONDS * 1000);

    const created = await this.db.$transaction(async (tx) => {
      const next = await tx.refreshToken.create({
        data: {
          userId: existing.userId,
          tokenHash: sha256(nextToken),
          familyId: existing.familyId,
          expiresAt: refreshTokenExpiresAt,
          ip: ctx.ip ?? null,
          userAgent: ctx.userAgent ?? null,
        },
      });
      await tx.refreshToken.update({
        where: { id: existing.id },
        data: { revokedAt: new Date(), revokedBy: 'rotation', replacedById: next.id },
      });
      return next;
    });

    const { token: accessToken, expiresAt: accessTokenExpiresAt } = await signAccessToken({
      userId: existing.userId,
      role: existing.user.role as UserRole,
      sessionId: existing.familyId,
      mfaSatisfied: existing.user.mfaEnabled,
    });

    await this.audit.recordSafe({
      action: AuditAction.TOKEN_REFRESHED,
      actorUserId: existing.userId,
      entityType: 'RefreshToken',
      entityId: created.id,
      sessionId: existing.familyId,
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent ?? null,
    });

    return {
      user: await this.describeUser(existing.user),
      accessToken,
      accessTokenExpiresAt,
      refreshToken: nextToken,
      refreshTokenExpiresAt,
      csrfToken: generateOpaqueToken(24),
      sessionId: existing.familyId,
    };
  }

  async logout(
    refreshToken: string | undefined,
    ctx: RequestContext & { userId?: string },
  ): Promise<void> {
    if (refreshToken) {
      const existing = await this.db.refreshToken.findUnique({
        where: { tokenHash: sha256(refreshToken) },
      });
      if (existing) await this.revokeFamily(existing.familyId, 'logout');
    }
    if (ctx.userId) {
      await this.audit.recordSafe({
        action: AuditAction.LOGOUT,
        actorUserId: ctx.userId,
        entityType: 'User',
        entityId: ctx.userId,
        ip: ctx.ip ?? null,
        userAgent: ctx.userAgent ?? null,
      });
    }
  }

  async revokeFamily(familyId: string, reason: string): Promise<void> {
    await this.db.refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date(), revokedBy: reason },
    });
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /**
   * Projects a database user into the shape the API and UI use. Portfolio ids
   * are resolved here so the client never has to guess what it may read.
   */
  async describeUser(user: User): Promise<AuthenticatedUser> {
    const role = user.role as UserRole;
    const portfolioIds = await this.accessiblePortfolioIds(user);
    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      role,
      mfaEnabled: user.mfaEnabled,
      permissions: [...permissionsForRole(role)],
      portfolioIds,
    };
  }

  /**
   * The authoritative list of portfolios a principal may touch. Admins see
   * every portfolio; everyone else sees explicit grants plus the portfolios of
   * the client they belong to.
   */
  async accessiblePortfolioIds(user: Pick<User, 'id' | 'role' | 'clientId'>): Promise<string[]> {
    if (user.role === UserRole.ADMIN) {
      const all = await this.db.portfolio.findMany({ select: { id: true } });
      return all.map((p) => p.id);
    }

    const [granted, viaClient] = await Promise.all([
      this.db.portfolioAccess.findMany({
        where: { userId: user.id },
        select: { portfolioId: true },
      }),
      user.clientId
        ? this.db.portfolio.findMany({
            where: {
              OR: [
                { clientId: user.clientId },
                { clientPortfolios: { some: { clientId: user.clientId } } },
              ],
            },
            select: { id: true },
          })
        : Promise.resolve([] as { id: string }[]),
    ]);

    return [...new Set([...granted.map((g) => g.portfolioId), ...viaClient.map((p) => p.id)])];
  }

  private checkTotp(user: User, totp: string): boolean {
    if (!user.mfaSecret) return false;
    let secret: string;
    try {
      secret = this.secretBox.decrypt(user.mfaSecret, user.id);
    } catch {
      return false;
    }
    return verifyTotp(totp, secret);
  }

  private async registerFailedLogin(user: User, ctx: RequestContext): Promise<void> {
    const failedLogins = user.failedLogins + 1;
    const lock = failedLogins >= MAX_FAILED_LOGINS;
    await this.db.user.update({
      where: { id: user.id },
      data: {
        failedLogins,
        lockedUntil: lock ? new Date(Date.now() + LOCKOUT_MINUTES * 60_000) : user.lockedUntil,
      },
    });
    await this.recordFailure(user, ctx, lock ? 'locked-out' : 'bad-password');
  }

  private async recordFailure(
    user: User,
    ctx: RequestContext,
    reason: string,
    action: string = AuditAction.LOGIN_FAILED,
  ): Promise<void> {
    await this.audit.recordSafe({
      action,
      actorUserId: user.id,
      entityType: 'User',
      entityId: user.id,
      metadata: { reason },
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent ?? null,
    });
  }
}
