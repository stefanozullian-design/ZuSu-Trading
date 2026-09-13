/**
 * Pulls real market data from the configured provider into the database.
 *
 * The counterpart to `backfill-demo`, and its opposite in one respect: that
 * script invents prices, this one fetches them. Both push their bars through
 * the same quality inspector, and both tag every row with where it came from,
 * so nothing downstream can confuse a simulated bar with a real one.
 *
 *   npm run sync:market                    -- a year of daily bars, every symbol
 *   npm run sync:market -- --days 30       -- a shorter window
 *   npm run sync:market -- --timeframe 5m  -- intraday, if the plan provides it
 *   npm run sync:market -- --symbols AAPL,MSFT
 *
 * It paces itself. A free provider plan allows a handful of requests a minute,
 * so the run is deliberately slow and says how long it expects to take rather
 * than earning a rate-limit refusal and failing halfway.
 */
import { buildContainer } from '../src/container.js';
import { DEFAULT_PACING_MS } from '../src/modules/market-data/market-data-sync.service.js';
import type { Timeframe } from '../src/modules/market-data/types.js';

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const container = buildContainer();

  const timeframe = (flag('timeframe') ?? '1d') as Timeframe;
  const days = Number(flag('days') ?? 365);
  const pacingMs = Number(flag('pacing') ?? DEFAULT_PACING_MS);
  const symbols = flag('symbols')
    ?.split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const planned = symbols ?? (await container.marketDataSync.syncableSymbols());
  const minutes = Math.ceil((planned.length * pacingMs) / 60_000);
  const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

  console.log(
    `\nSyncing ${timeframe} bars for ${String(planned.length)} ` +
      `${plural(planned.length, 'symbol', 'symbols')}, ${String(days)} days back.`,
  );
  console.log(
    `Pacing at one request every ${String(Math.round(pacingMs / 1000))}s to stay inside the ` +
      `provider's rate limit — expect roughly ${String(minutes)} ` +
      `${plural(minutes, 'minute', 'minutes')}.\n`,
  );

  const describe = (result: (typeof run)['results'][number]): string => {
    switch (result.status) {
      case 'STORED':
        return `${String(result.stored)} bars`;
      case 'NOTHING_RETURNED':
        return 'no data for this timeframe';
      case 'REJECTED':
        return `rejected (${String(result.findings.length)} findings)`;
      default:
        return 'failed';
    }
  };

  const run = await container.marketDataSync.sync({
    timeframe,
    days,
    pacingMs,
    ...(symbols && { symbols }),
    onProgress: (symbol, index, total) => {
      process.stdout.write(`  [${String(index + 1)}/${String(total)}] ${symbol.padEnd(6)} `);
    },
    onResult: (result) => {
      // On the same line the progress marker opened, so each symbol reads as
      // one row rather than a marker now and an answer several minutes later.
      console.log(describe(result));
      if (result.status === 'FAILED' || result.status === 'REJECTED') {
        console.log(`           ${result.detail}`);
      }
    },
  });

  console.log(`\n${run.summary}`);

  const nothing = run.results.filter((r) => r.status === 'NOTHING_RETURNED');
  if (nothing.length === run.results.length && run.results.length > 0) {
    console.log(
      `\nEvery symbol came back empty for ${timeframe}. That is what an end-of-day plan looks ` +
        'like when asked for intraday bars — try "--timeframe 1d".',
    );
  }

  await container.db.$disconnect();
}

main().catch((error: unknown) => {
  console.error(`\nSync failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
