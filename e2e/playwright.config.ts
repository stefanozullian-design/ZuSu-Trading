import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end suite.
 *
 * These specs drive a real browser against a real API and a real database.
 * They exist to catch what the unit and integration suites structurally
 * cannot: that the pieces are actually wired to each other, and that the
 * honesty rules the backend enforces survive all the way to the screen — a
 * null indicator rendered as `—` rather than `0`, an unevaluable symbol shown
 * rather than dropped, a permission withheld in the UI as well as the API.
 *
 * Deliberately few and deliberately about journeys. A large E2E suite that
 * asserts details already covered by faster tests is a maintenance cost that
 * buys nothing.
 */

const API_PORT = 4100;
const WEB_PORT = 5273;

// A dedicated database: these specs seed and mutate, and sharing the unit
// suite's database would make both non-deterministic.
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  'postgresql://zusu:zusu@127.0.0.1:5432/zusu_trading_e2e?schema=public';

const apiEnv = {
  NODE_ENV: 'development',
  DATABASE_URL,
  PORT: String(API_PORT),
  HOST: '127.0.0.1',
  LOG_LEVEL: 'warn',
  JWT_SECRET: 'e2e-jwt-secret-that-is-definitely-long-enough-000',
  COOKIE_SECRET: 'e2e-cookie-secret-that-is-definitely-long-enough',
  CREDENTIAL_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  COOKIE_SECURE: 'false',
  DEFAULT_ENVIRONMENT: 'DEMO',
  ALLOW_LIVE_TRADING: 'false',
  CORS_ORIGIN: `http://127.0.0.1:${String(WEB_PORT)}`,
  DEMO_SEED: '20260101',
  MARKET_DATA_PROVIDER: 'NONE',
  // A browser suite signs in a dozen times from one address, which trips the
  // auth rate limiter — a control doing its job, not a bug. Raised here for
  // the same reason the integration suite raises it: the limiter and account
  // lockout have their own tests, and neither is what these specs measure.
  RATE_LIMIT_MAX: '10000',
  AUTH_RATE_LIMIT_MAX: '1000',
};

export default defineConfig({
  testDir: './specs',
  outputDir: './.artifacts',
  fullyParallel: false,
  // Serial: the specs share one seeded database, and a kill switch engaged by
  // one spec would otherwise surface inside another.
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  timeout: 45_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL: `http://127.0.0.1:${String(WEB_PORT)}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ...devices['Desktop Chrome'],
    // CI runs `playwright install chromium` and needs no override. A sandbox
    // with a pinned browser build sets PLAYWRIGHT_CHROMIUM_PATH instead of
    // downloading a second copy.
    ...(process.env.PLAYWRIGHT_CHROMIUM_PATH
      ? { launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } }
      : {}),
  },

  globalSetup: './global-setup.ts',

  webServer: [
    {
      command: 'npm run dev:api',
      cwd: '..',
      url: `http://127.0.0.1:${String(API_PORT)}/api/system/live`,
      env: apiEnv,
      reuseExistingServer: !process.env.CI,
      stdout: 'ignore',
      stderr: 'pipe',
      timeout: 120_000,
    },
    {
      command: `npm run dev -w @zusu/web -- --port ${String(WEB_PORT)} --strictPort`,
      cwd: '..',
      url: `http://127.0.0.1:${String(WEB_PORT)}/`,
      env: { VITE_API_PROXY_TARGET: `http://127.0.0.1:${String(API_PORT)}` },
      reuseExistingServer: !process.env.CI,
      stdout: 'ignore',
      stderr: 'pipe',
      timeout: 120_000,
    },
  ],
});
