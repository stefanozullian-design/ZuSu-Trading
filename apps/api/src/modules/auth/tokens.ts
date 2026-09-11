import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import type { UserRole } from '@zusu/shared';
import { config } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';

const ISSUER = 'zusu-trading';
const ACCESS_AUDIENCE = 'zusu-api';
const MFA_AUDIENCE = 'zusu-mfa-challenge';

let secretKey: Uint8Array | null = null;
function key(): Uint8Array {
  secretKey ??= new TextEncoder().encode(config().JWT_SECRET);
  return secretKey;
}

/** Test helper: drops the cached key after the config is swapped. */
export function resetTokenKeyCache(): void {
  secretKey = null;
}

export interface AccessTokenClaims extends JWTPayload {
  sub: string;
  role: UserRole;
  /** Session id — the refresh-token family this access token belongs to. */
  sid: string;
  /** True once the MFA challenge for this session has been satisfied. */
  mfa: boolean;
}

export async function signAccessToken(claims: {
  userId: string;
  role: UserRole;
  sessionId: string;
  mfaSatisfied: boolean;
}): Promise<{ token: string; expiresAt: Date }> {
  const ttl = config().ACCESS_TOKEN_TTL_SECONDS;
  const expiresAt = new Date(Date.now() + ttl * 1000);
  const token = await new SignJWT({
    role: claims.role,
    sid: claims.sessionId,
    mfa: claims.mfaSatisfied,
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(claims.userId)
    .setIssuer(ISSUER)
    .setAudience(ACCESS_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .sign(key());
  return { token, expiresAt };
}

export async function verifyAccessToken(token: string): Promise<AccessTokenClaims> {
  try {
    const { payload } = await jwtVerify(token, key(), {
      issuer: ISSUER,
      audience: ACCESS_AUDIENCE,
    });
    if (typeof payload.sub !== 'string' || typeof payload.sid !== 'string') {
      throw new AppError('UNAUTHENTICATED', 'Malformed session token');
    }
    return payload as AccessTokenClaims;
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError('UNAUTHENTICATED', 'Session token is invalid or has expired', {
      cause: err,
    });
  }
}

/**
 * Short-lived proof that the password step succeeded. It is useless on its own:
 * only `/auth/mfa/verify` accepts it, and only together with a valid TOTP code.
 */
export async function signMfaChallengeToken(
  userId: string,
  purpose: 'VERIFY' | 'ENROL',
): Promise<string> {
  const ttl = config().MFA_TOKEN_TTL_SECONDS;
  return new SignJWT({ purpose })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(userId)
    .setIssuer(ISSUER)
    .setAudience(MFA_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(Math.floor((Date.now() + ttl * 1000) / 1000))
    .sign(key());
}

export async function verifyMfaChallengeToken(
  token: string,
): Promise<{ userId: string; purpose: 'VERIFY' | 'ENROL' }> {
  try {
    const { payload } = await jwtVerify(token, key(), { issuer: ISSUER, audience: MFA_AUDIENCE });
    const purpose = payload.purpose;
    if (typeof payload.sub !== 'string' || (purpose !== 'VERIFY' && purpose !== 'ENROL')) {
      throw new AppError('UNAUTHENTICATED', 'Malformed MFA challenge');
    }
    return { userId: payload.sub, purpose };
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError('UNAUTHENTICATED', 'MFA challenge is invalid or has expired', {
      cause: err,
    });
  }
}
