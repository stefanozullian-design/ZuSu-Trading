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

/**
 * Window and timeframes are overridable so a test run can seed a few days in
 * seconds rather than waiting on a month of five-minute bars.
 */
const TIMEFRAMES = (process.env.BACKFILL_TIMEFRAMES ?? '5m,1d')
  .split(',')
  .map((t) => t.trim())
  .filter(Boolean) as Timeframe[];
const DAYS_BACK = Number(process.env.BACKFILL_DAYS ?? '30');

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

  console.log('\nSeeding example scans…');
  const examples = [
    {
      name: 'Oversold pullback',
      description: 'RSI below 35 while price is still above its 50-period average.',
      timeframe: '5m' as const,
      conditions: [
        { field: 'rsi14' as const, operator: 'lt' as const, operand: { constant: '35' } },
        { field: 'close' as const, operator: 'gt' as const, operand: { field: 'sma50' as const } },
      ],
    },
    {
      name: 'MACD turning up',
      description: 'MACD crosses above its signal line — a momentum change, not a level.',
      timeframe: '5m' as const,
      conditions: [
        {
          field: 'macd' as const,
          operator: 'crosses_above' as const,
          operand: { field: 'macdSignal' as const },
        },
      ],
    },
    {
      name: 'Above the upper band',
      description: 'Close above the upper Bollinger band, with RSI confirming strength.',
      timeframe: '5m' as const,
      conditions: [
        {
          field: 'close' as const,
          operator: 'gt' as const,
          operand: { field: 'bollingerUpper' as const },
        },
        { field: 'rsi14' as const, operator: 'gt' as const, operand: { constant: '55' } },
      ],
    },
  ];

  for (const example of examples) {
    const existing = await container.db.scanDefinition.findUnique({
      where: { name: example.name },
    });
    if (existing) {
      console.log(`  ${example.name} (already present)`);
      continue;
    }
    await container.scans.create(example);
    console.log(`  ${example.name}`);
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
