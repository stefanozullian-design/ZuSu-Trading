import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { config } from '../config/env.js';
import { AppError } from '../lib/errors.js';
import { constantTimeEquals } from '../lib/crypto.js';

export const CSRF_COOKIE = 'zusu_csrf';
export const CSRF_HEADER = 'x-csrf-token';
export const ACCESS_COOKIE = 'zusu_at';
export const REFRESH_COOKIE = 'zusu_rt';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Pre-session endpoints: the caller cannot yet hold a CSRF token. They are
 * still protected by `SameSite=Lax` cookies (a cross-site POST carries no
 * cookies at all) and by the stricter auth rate limit.
 */
const CSRF_EXEMPT_PATHS = new Set([
  '/api/auth/login',
  '/api/auth/mfa/enrol',
  '/api/auth/mfa/verify',
  '/api/auth/refresh',
]);

/**
 * Transport-level protections (§52): security headers, CORS with credentials
 * restricted to the configured origin, cookie parsing, rate limiting and CSRF.
 */
export const securityPlugin = fp(async (app: FastifyInstance) => {
  const cfg = config();

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        // The Swagger UI bundle is served from the API itself.
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
    hsts: cfg.isProduction ? { maxAge: 31_536_000, includeSubDomains: true } : false,
  });

  await app.register(cors, {
    origin: cfg.CORS_ORIGIN.split(',').map((o) => o.trim()),
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['content-type', CSRF_HEADER],
  });

  await app.register(cookie, {
    secret: cfg.COOKIE_SECRET,
    parseOptions: { httpOnly: true, sameSite: 'lax', secure: cfg.COOKIE_SECURE, path: '/' },
  });

  await app.register(rateLimit, {
    global: true,
    max: cfg.RATE_LIMIT_MAX,
    timeWindow: cfg.RATE_LIMIT_WINDOW,
    // Rate limits are per-principal where we know one, per-IP otherwise.
    keyGenerator: (req) => req.principal?.id ?? req.ip,
    errorResponseBuilder: () => ({
      error: { code: 'RATE_LIMITED', message: 'Too many requests. Slow down and try again.' },
    }),
  });

  /**
   * Double-submit CSRF: the browser sends the token both as a readable cookie
   * and as a header. A cross-site attacker can cause the cookie to be sent but
   * cannot read it to set the header.
   */
  app.addHook('onRequest', async (request) => {
    if (SAFE_METHODS.has(request.method)) return;
    if (CSRF_EXEMPT_PATHS.has(request.url.split('?')[0] ?? '')) return;
    if (request.headers.authorization) return; // Bearer callers are not cookie-driven.

    const cookieToken = request.cookies[CSRF_COOKIE];
    const headerToken = request.headers[CSRF_HEADER];
    if (!cookieToken || typeof headerToken !== 'string') {
      throw new AppError('FORBIDDEN', 'Missing CSRF token');
    }
    if (!constantTimeEquals(cookieToken, headerToken)) {
      throw new AppError('FORBIDDEN', 'CSRF token mismatch');
    }
  });
});
