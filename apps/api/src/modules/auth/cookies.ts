import type { FastifyReply } from 'fastify';
import { config } from '../../config/env.js';
import { ACCESS_COOKIE, CSRF_COOKIE, REFRESH_COOKIE } from '../../plugins/security.js';
import type { IssuedSession } from './auth.service.js';

/**
 * Session cookies.
 *
 * The tokens are `httpOnly` so no script can read them; the CSRF token is
 * deliberately readable, because the browser must echo it back in a header.
 */
export function setSessionCookies(reply: FastifyReply, session: IssuedSession): void {
  const cfg = config();
  const base = {
    httpOnly: true,
    secure: cfg.COOKIE_SECURE,
    sameSite: 'lax' as const,
    path: '/',
    ...(cfg.COOKIE_DOMAIN ? { domain: cfg.COOKIE_DOMAIN } : {}),
  };

  reply.setCookie(ACCESS_COOKIE, session.accessToken, {
    ...base,
    expires: session.accessTokenExpiresAt,
  });
  reply.setCookie(REFRESH_COOKIE, session.refreshToken, {
    ...base,
    // Only the refresh endpoint ever needs this cookie.
    path: '/api/auth',
    expires: session.refreshTokenExpiresAt,
  });
  reply.setCookie(CSRF_COOKIE, session.csrfToken, {
    ...base,
    httpOnly: false,
    expires: session.refreshTokenExpiresAt,
  });
}

export function clearSessionCookies(reply: FastifyReply): void {
  const cfg = config();
  const base = {
    path: '/',
    secure: cfg.COOKIE_SECURE,
    sameSite: 'lax' as const,
    ...(cfg.COOKIE_DOMAIN ? { domain: cfg.COOKIE_DOMAIN } : {}),
  };
  reply.clearCookie(ACCESS_COOKIE, base);
  reply.clearCookie(REFRESH_COOKIE, { ...base, path: '/api/auth' });
  reply.clearCookie(CSRF_COOKIE, base);
}
