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
