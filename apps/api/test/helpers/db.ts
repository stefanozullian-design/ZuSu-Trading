import { PrismaClient } from '@prisma/client';

let client: PrismaClient | null = null;

export function testDb(): PrismaClient {
  client ??= new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL as string } } });
  return client;
}

/** Tables cleared between tests, ordered so foreign keys never block a delete. */
const TABLES = [
  'audit_logs',
  'signal_events',
  'order_events',
  'executions',
  'position_lots',
  'positions',
  'orders',
  'signals',
  'ai_analyses',
  'reconciliations',
  'broker_accounts',
  'risk_events',
  'risk_limits',
  'portfolio_snapshots',
  'performance_metrics',
  'fees',
  'cash_flows',
  'paper_trades',
  'trade_journal_entries',
  'backtest_trades',
  'backtests',
  'strategy_portfolio_configs',
  'strategy_versions',
  'strategies',
  'watchlist_items',
  'watchlists',
  'notifications',
  'reports',
  'client_consents',
  'compliance_documents',
  'portfolio_access',
  'client_portfolios',
  'portfolios',
  'refresh_tokens',
  'users',
  'clients',
  'system_health_checks',
  'market_data_quality_events',
  'market_data_quotes',
  'market_data_candles',
  'option_contracts',
  'instruments',
  'market_regimes',
  'market_calendar_days',
];

/**
 * Truncates every table.
 *
 * `audit_logs` refuses TRUNCATE by design, so the trigger is switched off for
 * exactly the length of the reset. This is the only place in the repository
 * that does it, and it runs only against the test database.
 */
export async function resetDatabase(): Promise<void> {
  const db = testDb();
  if (!/zusu_trading_test/.test(process.env.DATABASE_URL ?? '')) {
    throw new Error('resetDatabase refused to run outside the test database');
  }
  await db.$executeRawUnsafe('ALTER TABLE audit_logs DISABLE TRIGGER USER');
  try {
    await db.$executeRawUnsafe(
      `TRUNCATE TABLE ${TABLES.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`,
    );
  } finally {
    await db.$executeRawUnsafe('ALTER TABLE audit_logs ENABLE TRIGGER USER');
  }
}

export async function disconnectTestDb(): Promise<void> {
  if (client) {
    await client.$disconnect();
    client = null;
  }
}
