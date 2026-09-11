import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  authenticatedUserSchema,
  loginRequestSchema,
  loginResponseSchema,
  mfaActivateRequestSchema,
  mfaEnrollResponseSchema,
  mfaVerifyRequestSchema,
} from '@zusu/shared';
import { config } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';
import { principalOf } from '../../plugins/auth.js';
import { REFRESH_COOKIE } from '../../plugins/security.js';
import type { AppContainer } from '../../container.js';
import { clearSessionCookies, setSessionCookies } from './cookies.js';
import { signMfaChallengeToken } from './tokens.js';

const enrolWithChallengeSchema = z.object({ mfaToken: z.string().min(1) });

export async function registerAuthRoutes(
  app: FastifyInstance,
  container: AppContainer,
): Promise<void> {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const cfg = config();

  /** Stricter budget for credential endpoints than the global limit (§54). */
  const authRateLimit = {
    rateLimit: { max: cfg.AUTH_RATE_LIMIT_MAX, timeWindow: '1 minute' },
  };

  typed.post(
    '/login',
    {
      config: authRateLimit,
      schema: {
        tags: ['auth'],
        summary: 'Sign in with email and password',
        description:
          'Returns a session, or an MFA challenge when the account requires a second factor. ' +
          'Administrators must complete MFA enrolment before a session is issued.',
        body: loginRequestSchema,
        response: { 200: loginResponseSchema },
      },
    },
    async (request, reply) => {
      const ctx = { ip: request.ip, userAgent: request.headers['user-agent'] ?? null };
      const outcome = await container.auth.login(
        request.body.email,
        request.body.password,
        request.body.totp,
        ctx,
      );

      if (outcome.status === 'MFA_REQUIRED' || outcome.status === 'MFA_ENROLMENT_REQUIRED') {
        return reply.send({ status: outcome.status, mfaToken: outcome.mfaToken });
      }

      setSessionCookies(reply, outcome.session);
      return reply.send({
        status: 'AUTHENTICATED' as const,
        user: outcome.session.user,
        csrfToken: outcome.session.csrfToken,
        accessTokenExpiresAt: outcome.session.accessTokenExpiresAt.toISOString(),
      });
    },
  );

  typed.post(
    '/mfa/enrol',
    {
      config: authRateLimit,
      schema: {
        tags: ['auth'],
        summary: 'Start multi-factor enrolment using a login challenge token',
        body: enrolWithChallengeSchema,
        response: { 200: mfaEnrollResponseSchema },
      },
    },
    async (request, reply) => {
      const result = await container.auth.beginMfaEnrolmentWithChallenge(request.body.mfaToken);
      return reply.send({
        secret: result.secret,
        otpauthUrl: result.otpauthUrl,
        qrDataUrl: result.qrDataUrl,
      });
    },
  );

  typed.post(
    '/mfa/verify',
    {
      config: authRateLimit,
      schema: {
        tags: ['auth'],
        summary: 'Complete an MFA challenge and receive a session',
        body: mfaVerifyRequestSchema,
        response: {
          200: z.object({
            status: z.literal('AUTHENTICATED'),
            user: authenticatedUserSchema,
            csrfToken: z.string(),
            accessTokenExpiresAt: z.string().datetime(),
          }),
        },
      },
    },
    async (request, reply) => {
      const session = await container.auth.completeMfaChallenge(
        request.body.mfaToken,
        request.body.totp,
        { ip: request.ip, userAgent: request.headers['user-agent'] ?? null },
      );
      setSessionCookies(reply, session);
      return reply.send({
        status: 'AUTHENTICATED' as const,
        user: session.user,
        csrfToken: session.csrfToken,
        accessTokenExpiresAt: session.accessTokenExpiresAt.toISOString(),
      });
    },
  );

  typed.post(
    '/mfa/setup',
    {
      preHandler: app.requireAuth,
      schema: {
        tags: ['auth'],
        summary: 'Start multi-factor enrolment for the signed-in user',
        response: { 200: mfaEnrollResponseSchema },
      },
    },
    async (request, reply) => {
      const principal = principalOf(request);
      const result = await container.auth.beginMfaEnrolment(principal.id);
      return reply.send(result);
    },
  );

  typed.post(
    '/mfa/activate',
    {
      preHandler: app.requireAuth,
      schema: {
        tags: ['auth'],
        summary: 'Confirm an authenticator code and switch MFA on',
        body: mfaActivateRequestSchema,
        response: { 200: z.object({ mfaEnabled: z.literal(true) }) },
      },
    },
    async (request, reply) => {
      const principal = principalOf(request);
      const user = await container.db.user.findUniqueOrThrow({ where: { id: principal.id } });
      if (user.mfaEnabled) {
        throw new AppError('CONFLICT', 'Multi-factor authentication is already active');
      }
      // Reuses the challenge path so enrolment has exactly one implementation.
      const session = await container.auth.completeMfaChallenge(
        await signMfaChallengeToken(principal.id, 'ENROL'),
        request.body.totp,
        { ip: request.ip, userAgent: request.headers['user-agent'] ?? null },
      );
      setSessionCookies(reply, session);
      return reply.send({ mfaEnabled: true as const });
    },
  );

  typed.post(
    '/refresh',
    {
      config: authRateLimit,
      schema: {
        tags: ['auth'],
        summary: 'Rotate the refresh token and issue a new access token',
        response: {
          200: z.object({
            user: authenticatedUserSchema,
            csrfToken: z.string(),
            accessTokenExpiresAt: z.string().datetime(),
          }),
        },
      },
    },
    async (request, reply) => {
      const token = request.cookies[REFRESH_COOKIE];
      if (!token) throw new AppError('UNAUTHENTICATED', 'No session to refresh');
      const session = await container.auth.refresh(token, {
        ip: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      });
      setSessionCookies(reply, session);
      return reply.send({
        user: session.user,
        csrfToken: session.csrfToken,
        accessTokenExpiresAt: session.accessTokenExpiresAt.toISOString(),
      });
    },
  );

  typed.post(
    '/logout',
    {
      schema: {
        tags: ['auth'],
        summary: 'Revoke the current session',
        response: { 200: z.object({ ok: z.literal(true) }) },
      },
    },
    async (request, reply) => {
      await container.auth.logout(request.cookies[REFRESH_COOKIE], {
        ip: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
        userId: request.principal?.id,
      });
      clearSessionCookies(reply);
      return reply.send({ ok: true as const });
    },
  );

  typed.get(
    '/me',
    {
      preHandler: app.requireAuth,
      schema: {
        tags: ['auth'],
        summary: 'The signed-in user, their permissions and reachable portfolios',
        response: { 200: authenticatedUserSchema },
      },
    },
    async (request, reply) => {
      const principal = principalOf(request);
      const user = await container.db.user.findUniqueOrThrow({ where: { id: principal.id } });
      return reply.send(await container.auth.describeUser(user));
    },
  );
}
