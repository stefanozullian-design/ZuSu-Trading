/**
 * Populates the demo market-data pipeline so the Market page has something to
 * show without a provider key.
 *
 * Runs the real path: the market calendar is synced first, then simulated bars
 * are pushed through the quality layer, which inspects and stores them. Every
 * row is tagged `demo-simulator`, so nothing written here can be confused with
 * live data.
 */
import { buildContainer } from '../src/container.js';
import type { Timeframe } from '../src/modules/market-data/types.js';

const TIMEFRAMES: Timeframe[] = ['5m', '1d'];
const DAYS_BACK = 30;

async function main(): Promise<void> {
  const container = buildContainer();
  const now = new Date();
  const from = new Date(now.getTime() - DAYS_BACK * 86_400_000);

  console.log('Syncing market calendars…');
  for (const market of ['XNYS', 'CRYPTO']) {
    const summary = await container.calendar.sync(
      market,
      from,
      new Date(now.getTime() + 14 * 86_400_000),
    );
    console.log(`  ${market}: ${summary.daysWritten} days`);
  }

  await container.demoFeed.ensureInstruments();

  for (const timeframe of TIMEFRAMES) {
    console.log(`\nBackfilling ${timeframe} bars over the last ${DAYS_BACK} days…`);
    const summaries = await container.demoFeed.backfillAll(timeframe, from, now);
    for (const summary of summaries) {
      const note = summary.rejected > 0 ? `  (${summary.rejected} rejected)` : '';
      console.log(
        `  ${summary.symbol.padEnd(6)} ${String(summary.stored).padStart(5)} bars${note}`,
      );
    }
  }

  const verdict = await container.dataQuality.verdict();
  console.log(
    `\nData quality: ${verdict.ok ? 'no open blocking events' : `${verdict.feedWide.length + verdict.bySymbol.length} open blocking event(s)`}`,
  );

  const total = await container.db.marketDataCandle.count();
  console.log(`Stored ${total} candles in total.\n`);
  await container.db.$disconnect();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
