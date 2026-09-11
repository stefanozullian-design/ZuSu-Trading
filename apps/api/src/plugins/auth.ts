import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify';
import fp from 'fastify-plugin';
import type { Permission } from '@zusu/shared';
import type { AppContainer } from '../container.js';
import { AppError } from '../lib/errors.js';
import type { Principal } from '../modules/rbac/access-control.js';
import { verifyAccessToken } from '../modules/auth/tokens.js';
import { ACCESS_COOKIE } from './security.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** The authenticated user, loaded fresh from the database each request. */
    principal?: Principal;
    sessionId?: string;
  }
  interface FastifyInstance {
    requireAuth: preHandlerHookHandler;
    requirePermission(permission: Permission): preHandlerHookHandler;
  }
}

function extractToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7);
  return request.cookies[ACCESS_COOKIE] ?? null;
}

/**
 * Authentication.
 *
 * The access token proves *who* is calling; the user row is then reloaded on
 * every request so that a disabled account or a changed role takes effect
 * immediately rather than at the next token refresh.
 */
export const authPlugin = fp<{ container: AppContainer }>(async (app: FastifyInstance, opts) => {
  const { container } = opts;

  async function authenticate(request: FastifyRequest): Promise<void> {
    const token = extractToken(request);
    if (!token) throw new AppError('UNAUTHENTICATED', 'Authentication required');

    const claims = await verifyAccessToken(token);
    const user = await container.db.user.findUnique({
      where: { id: claims.sub },
      select: {
        id: true,
        role: true,
        clientId: true,
        email: true,
        isActive: true,
        mfaEnabled: true,
      },
    });

    if (!user || !user.isActive) {
      throw new AppError('UNAUTHENTICATED', 'Account is unavailable');
    }
    // A session issued before MFA enrolment must not survive the change.
    if (user.mfaEnabled && !claims.mfa) {
      throw new AppError('MFA_REQUIRED', 'This session predates multi-factor enrolment');
    }

    request.principal = {
      id: user.id,
      role: user.role,
      clientId: user.clientId,
      email: user.email,
      isActive: user.isActive,
    };
    request.sessionId = claims.sid;
  }

  app.decorate('requireAuth', async function requireAuth(request) {
    await authenticate(request);
  } satisfies preHandlerHookHandler);

  app.decorate('requirePermission', (permission: Permission): preHandlerHookHandler => {
    return async function requirePermissionHandler(request) {
      await authenticate(request);
      container.access.assertPermission(request.principal as Principal, permission);
    };
  });
});

/** Narrows the optional decorator for handlers that ran behind `requireAuth`. */
export function principalOf(request: FastifyRequest): Principal {
  if (!request.principal) throw new AppError('UNAUTHENTICATED', 'Authentication required');
  return request.principal;
}
