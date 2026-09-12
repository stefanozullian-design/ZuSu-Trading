import { execFileSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import { rmSync } from 'node:fs';
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

/**
 * Marks the instant this run starts as an open session on XNYS.
 *
 * The trading gate refuses a closed market, which is correct and is tested
 * directly. But a browser suite that can only exercise the approval journey
 * between 09:30 and 16:00 on a weekday is a suite that mostly does not run —
 * and "the human gate works" is the single most important thing here to keep
 * covered. So the fixture opens the session, explicitly and only in the E2E
 * database, rather than the gate pretending Saturday is Tuesday.
 */
async function openTheSessionForThisRun(): Promise<void> {
  const db = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  try {
    const now = new Date();
    const date = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0),
    );
    const open = new Date(date.getTime());
    const close = new Date(date.getTime() + 86_400_000 - 1);

    for (const marketCode of ['XNYS', 'CRYPTO']) {
      await db.marketCalendarDay.upsert({
        where: { marketCode_date: { marketCode, date } },
        update: {
          isTradingDay: true,
          preMarketOpen: open,
          regularOpen: open,
          regularClose: close,
          afterHoursClose: close,
          holidayName: null,
        },
        create: {
          marketCode,
          date,
          isTradingDay: true,
          preMarketOpen: open,
          regularOpen: open,
          regularClose: close,
          afterHoursClose: close,
        },
      });
    }
  } finally {
    await db.$disconnect();
  }
}

export default async function globalSetup(): Promise<void> {
  // The administrator's MFA secret belongs to the database that issued it.
  // Reseeding invalidates it, and a stale note would send the next admin
  // sign-in into a loop of rejected codes.
  rmSync(path.join(repoRoot, 'e2e/.artifacts/admin-mfa-secret'), { force: true });

  // `migrate reset --force` drops and recreates, so a rerun starts from a
  // known state rather than inheriting whatever the last run left behind.
  run('npx', ['--workspace', '@zusu/api', 'prisma', 'migrate', 'reset', '--force', '--skip-seed']);
  run('npm', ['run', 'seed']);
  run('npm', ['run', 'backfill:demo']);

  // Last, so the backfill's own calendar sync cannot overwrite it.
  await openTheSessionForThisRun();
}
