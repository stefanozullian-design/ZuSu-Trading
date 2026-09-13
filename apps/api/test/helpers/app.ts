import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { buildContainer, type AppContainer } from '../../src/container.js';
import { createLogger } from '../../src/lib/logger.js';
import { testDb } from './db.js';
import { TEST_PASSWORD } from './fixtures.js';

export interface TestApp {
  app: FastifyInstance;
  container: AppContainer;
  close(): Promise<void>;
}

export async function buildTestApp(): Promise<TestApp> {
  const container = buildContainer({ db: testDb(), logger: createLogger() });
  const { app } = await buildApp({ container });
  await app.ready();
  return {
    app,
    container,
    close: async () => {
      await app.close();
    },
  };
}

export interface Session {
  cookies: string;
  csrfToken: string;
  /** Headers for a mutating request: session cookies plus the CSRF echo. */
  headers(extra?: Record<string, string>): Record<string, string>;
}

/**
 * Signs an administrator in through the whole enrol-then-verify flow.
 *
 * Administrators must carry a second factor, so a plain `login` gets an
 * MFA_ENROLMENT_REQUIRED challenge rather than a session. Every suite that
 * exercises an administrator-only route needs this, which is why it lives here
 * rather than being written out again in each of them.
 */
export async function loginAdmin(
  app: FastifyInstance,
  email: string,
  password: string = TEST_PASSWORD,
): Promise<Session> {
  const challenge = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password },
  });
  const { mfaToken } = challenge.json() as { mfaToken?: string };
  if (typeof mfaToken !== 'string') {
    // Already enrolled, or not an administrator at all. Either way this helper
    // is the wrong one and saying so beats a confusing failure further down.
    throw new Error(`no MFA challenge for ${email}: ${JSON.stringify(challenge.json())}`);
  }

  const enrol = await app.inject({
    method: 'POST',
    url: '/api/auth/mfa/enrol',
    payload: { mfaToken },
  });
  const { secret } = enrol.json() as { secret: string };

  const { currentTotp } = await import('../../src/modules/auth/mfa.js');
  const verify = await app.inject({
    method: 'POST',
    url: '/api/auth/mfa/verify',
    payload: { mfaToken, totp: currentTotp(secret) },
  });

  return sessionFromResponse(verify.cookies, (verify.json() as { csrfToken: string }).csrfToken);
}

/** Signs in and captures the cookies exactly as a browser would. */
export async function login(
  app: FastifyInstance,
  email: string,
  password: string = TEST_PASSWORD,
  totp?: string,
): Promise<Session> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password, ...(totp ? { totp } : {}) },
  });

  const body = response.json();
  if (body.status !== 'AUTHENTICATED') {
    throw new Error(`login did not authenticate: ${JSON.stringify(body)}`);
  }
  return sessionFromResponse(response.cookies, body.csrfToken);
}

export function sessionFromResponse(
  cookies: Array<{ name: string; value: string }>,
  csrfToken: string,
): Session {
  const header = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  return {
    cookies: header,
    csrfToken,
    headers: (extra = {}) => ({
      cookie: header,
      'x-csrf-token': csrfToken,
      ...extra,
    }),
  };
}
