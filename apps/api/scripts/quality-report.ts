/**
 * Prints the data-quality findings currently blocking trades.
 *
 * The findings are recorded, they block trading, and until now the only way to
 * read them was to hunt through a panel on the market page. Something that
 * stops you trading should be one command away from explaining itself.
 *
 *   npm run quality:report
 *   npm run quality:report -- --all        include resolved ones
 *   npm run quality:report -- --symbol AAPL
 */
import { buildContainer } from '../src/container.js';

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const container = buildContainer();
  const includeResolved = process.argv.includes('--all');
  const symbol = flag('symbol')?.toUpperCase();

  const events = await container.db.marketDataQualityEvent.findMany({
    where: {
      ...(includeResolved ? {} : { resolvedAt: null }),
      ...(symbol ? { symbol } : {}),
    },
    orderBy: [{ symbol: 'asc' }, { detectedAt: 'asc' }],
    take: 500,
  });

  if (events.length === 0) {
    console.log('\nNo data-quality findings. Nothing is blocking trades on this front.\n');
    await container.db.$disconnect();
    return;
  }

  // Grouped by the kind of problem, because a hundred findings of one kind is
  // one problem and reading them one at a time hides that.
  const byIssue = new Map<string, typeof events>();
  for (const event of events) {
    const list = byIssue.get(event.issue) ?? [];
    list.push(event);
    byIssue.set(event.issue, list);
  }

  console.log(`\n${String(events.length)} finding(s), by kind:\n`);
  for (const [issue, list] of byIssue) {
    const blocking = list.filter((e) => e.blocking).length;
    const symbols = [...new Set(list.map((e) => e.symbol ?? 'feed-wide'))];
    console.log(`${issue} — ${String(list.length)} (${String(blocking)} blocking)`);
    console.log(`  symbols: ${symbols.join(', ')}`);
    console.log('  examples:');
    for (const event of list.slice(0, 3)) {
      console.log(`    · ${event.symbol ?? 'feed-wide'}: ${event.detail}`);
    }
    console.log('');
  }

  console.log(
    'A blocking finding stops new trades until it is resolved. That is the ' +
      'point of recording it — nothing downgrades one quietly.\n',
  );

  await container.db.$disconnect();
}

main().catch((error: unknown) => {
  console.error(
    `\nCould not read the findings: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
