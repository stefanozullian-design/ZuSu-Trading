import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Prepares a dedicated database for the end-to-end run.
 *
 * Runs the real setup path a person would follow from the README — migrate,
 * seed, backfill — rather than inserting rows directly. If those commands
 * break, the E2E suite should fail, because a new contributor following the
 * README would hit the same wall.
 *
 * The backfill window is deliberately short. Thirty days of five-minute bars
 * takes a couple of minutes; four days is enough for every assertion here and
 * runs in seconds. One assertion depends on it: a 50-period average cannot
 * exist in four days of *daily* bars, which is what makes the scanner's
 * "could not evaluate" path reachable.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  'postgresql://zusu:zusu@127.0.0.1:5432/zusu_trading_e2e?schema=public';

const env = {
  ...process.env,
  DATABASE_URL,
  NODE_ENV: 'development',
  JWT_SECRET: 'e2e-jwt-secret-that-is-definitely-long-enough-000',
  COOKIE_SECRET: 'e2e-cookie-secret-that-is-definitely-long-enough',
  CREDENTIAL_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  COOKIE_SECURE: 'false',
  DEFAULT_ENVIRONMENT: 'DEMO',
  ALLOW_LIVE_TRADING: 'false',
  DEMO_SEED: '20260101',
  MARKET_DATA_PROVIDER: 'NONE',
  BACKFILL_DAYS: '4',
  BACKFILL_TIMEFRAMES: '5m,1d',
};

function run(command: string, args: string[]): void {
  execFileSync(command, args, { cwd: repoRoot, env, stdio: 'inherit' });
}

export default function globalSetup(): void {
  // `migrate reset --force` drops and recreates, so a rerun starts from a
  // known state rather than inheriting whatever the last run left behind.
  run('npx', ['--workspace', '@zusu/api', 'prisma', 'migrate', 'reset', '--force', '--skip-seed']);
  run('npm', ['run', 'seed']);
  run('npm', ['run', 'backfill:demo']);
}
