import { execSync } from 'node:child_process';

/**
 * Brings the test database up to the current migration state once per run.
 * Using `migrate deploy` (not `db push`) means the tests exercise the same
 * SQL — triggers and constraints included — that production will run.
 */
export default function globalSetup(): void {
  const url =
    process.env.TEST_DATABASE_URL ??
    'postgresql://zusu:zusu@127.0.0.1:5432/zusu_trading_test?schema=public';
  execSync('npx prisma migrate deploy', {
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'inherit',
  });
}
