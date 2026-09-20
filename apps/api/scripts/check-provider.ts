/**
 * Asks the market-data provider what your plan actually allows.
 *
 * Written because the question "can my plan import 160 symbols?" was being
 * answered by guessing, and guessing wrong costs an hour of paced requests
 * that die halfway. One cheap call turns it into a number.
 *
 *   npm run check:provider               -- one call, report what it disclosed
 *   npm run check:provider -- --measure  -- find the real ceiling by measuring
 *   npm run check:provider -- --symbols 160
 *
 * The measured mode exists because a provider that sends no rate-limit headers
 * is common, and silence is not headroom. It makes a small burst of cheap
 * calls and times them until one is refused, which is the only way to learn a
 * ceiling nobody will state. It is opt-in, bounded, and says what it spent.
 *
 * The API key is never printed, not even partially.
 */
import { MassiveProvider } from '../src/modules/market-data/massive-provider.js';
import { config } from '../src/config/env.js';

/** What one symbol costs to import: verify it exists, then both timeframes. */
const CALLS_PER_SYMBOL = 3;
/** Never spend more than this on measuring, however the burst goes. */
const MEASURE_CAP = 12;

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function has(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

async function main(): Promise<void> {
  const cfg = config();

  console.log('\n─── Market-data provider ───\n');

  if (cfg.MARKET_DATA_PROVIDER === 'NONE') {
    console.log('No provider is configured, so there is nothing to ask.');
    console.log('Set MARKET_DATA_PROVIDER and its key in .env, then run this again.\n');
    process.exitCode = 1;
    return;
  }

  console.log(`Provider   ${cfg.MARKET_DATA_PROVIDER}`);
  console.log(`Endpoint   ${cfg.MASSIVE_BASE_URL ?? 'https://api.massive.com'}`);
  console.log(`Feed       ${cfg.MASSIVE_IS_DELAYED ? 'delayed' : 'real-time'}`);
  // Said, never shown. Whether a key exists is the useful fact; its value is
  // not, and a log line is exactly where a credential should never end up.
  console.log(`Key        ${cfg.MASSIVE_API_KEY ? 'present' : 'MISSING'}\n`);

  const provider = new MassiveProvider({
    apiKey: cfg.MASSIVE_API_KEY as string,
    baseUrl: cfg.MASSIVE_BASE_URL,
    timeoutMs: cfg.MASSIVE_TIMEOUT_MS,
    isDelayed: cfg.MASSIVE_IS_DELAYED,
  });

  const health = await provider.healthCheck();
  if (!health.ok) {
    console.log(`The provider refused the call: ${health.detail ?? 'no reason given'}`);
    console.log(
      '\nIf that mentions the key or the plan, the import cannot proceed until it is fixed.\n',
    );
    process.exitCode = 1;
    return;
  }

  console.log(`Reachable  yes, in ${String(health.latencyMs ?? 0)}ms\n`);

  const reading = provider.lastRateLimit();
  if (!reading || reading.headers.length === 0) {
    console.log('Rate limit This provider sent no rate-limit headers.');
    console.log(
      '           That is not the same as having no limit — it means the ceiling\n' +
        '           is undisclosed, and the only way to learn it is to measure it.\n' +
        '           Re-run with --measure to find out.\n',
    );
  } else {
    console.log(`Rate limit headers: ${reading.headers.join(', ')}`);
    if (reading.limit !== null) console.log(`           limit:     ${String(reading.limit)}`);
    if (reading.remaining !== null)
      console.log(`           remaining: ${String(reading.remaining)}`);
    if (reading.resetRaw !== null) console.log(`           reset:     ${reading.resetRaw} (raw)`);
    console.log('');
  }

  let measurement: Measurement | null = null;
  if (has('measure')) {
    measurement = await measure(provider);
    report(measurement);
  }

  estimate(Number(flag('symbols') ?? 160), measurement, reading?.limit ?? null);
}

/**
 * What a burst of cheap calls revealed.
 *
 * Deliberately not a rate. A burst that is never refused establishes a floor
 * on how many calls fit back to back and says nothing whatever about a
 * per-minute ceiling — dividing the burst by its own duration produces
 * "48,000 a minute" from twelve calls in a quarter of a second, which is a
 * number that looks like measurement and is arithmetic on noise.
 */
type Measurement =
  | { kind: 'refused'; landed: number; elapsedMs: number }
  | { kind: 'unrefused'; landed: number; elapsedMs: number };

/**
 * Finds the ceiling by walking into it.
 *
 * Crude on purpose: make cheap calls back to back and see whether one is
 * refused. The import does not need the exact limit, only whether it has to
 * pace — and a burst that survives rules out the tightest tiers, which is the
 * answer that actually changes what we do next.
 */
async function measure(provider: MassiveProvider): Promise<Measurement> {
  console.log(`Measuring  up to ${String(MEASURE_CAP)} calls, stopping at the first refusal…`);

  const started = Date.now();
  let landed = 0;

  for (let i = 0; i < MEASURE_CAP; i += 1) {
    try {
      // `ok` first, and not only the header. healthCheck catches its own
      // errors and reports them as ok:false, so a provider that refuses with a
      // 429 and no rate-limit header would otherwise be counted as a success
      // — and a metered plan would be reported as unmetered, which is the one
      // wrong answer that costs an hour.
      const health = await provider.healthCheck();
      const reading = provider.lastRateLimit();
      if (!health.ok || reading?.remaining === 0) {
        return { kind: 'refused', landed, elapsedMs: Date.now() - started };
      }
      landed += 1;
    } catch {
      return { kind: 'refused', landed, elapsedMs: Date.now() - started };
    }
  }

  return { kind: 'unrefused', landed, elapsedMs: Date.now() - started };
}

function report(measurement: Measurement): void {
  const seconds = Math.max(Math.round(measurement.elapsedMs / 1000), 1);

  if (measurement.kind === 'refused') {
    console.log(
      `           refused after ${String(measurement.landed)} ` +
        `${plural(measurement.landed, 'call', 'calls')}. The plan is metered, and the\n` +
        '           import must pace itself.\n',
    );
    return;
  }

  console.log(
    `           ${String(measurement.landed)} ` +
      `${plural(measurement.landed, 'call', 'calls')} in about ${String(seconds)}s, ` +
      'none refused.\n',
  );
  console.log(
    '           That rules out the tightest tiers — a few-calls-a-minute plan would\n' +
      '           have refused this burst. It does not establish a per-minute rate, and\n' +
      '           dividing the burst by its own duration would invent one.\n',
  );
}

/** What the planned import would cost, in the terms a person decides with. */
function estimate(symbols: number, measurement: Measurement | null, limit: number | null): void {
  const calls = symbols * CALLS_PER_SYMBOL;

  console.log('─── What the import would cost ───\n');
  console.log(
    `${String(symbols)} symbols × ${String(CALLS_PER_SYMBOL)} calls each ` +
      `(exists, daily bars, 5-minute bars) = about ${String(calls)} calls, once.\n`,
  );

  if (limit !== null && limit > 0) {
    const windows = Math.ceil(calls / limit);
    console.log(
      `The provider states a limit of ${String(limit)} per window, so that is about ` +
        `${String(windows)} ${plural(windows, 'window', 'windows')}.`,
    );
    console.log('How long a window is, only the provider’s own plan page says.');
  } else if (measurement?.kind === 'unrefused') {
    console.log(
      `A burst of ${String(measurement.landed)} was not refused and no limit was stated, so\n` +
        'nothing here fixes a duration. Start the import; it reports what it spends as it\n' +
        'goes, and it can be stopped and resumed without waste.',
    );
  } else if (measurement?.kind === 'refused') {
    console.log(
      'The plan refused a short burst, so the import must pace itself. Run it with a\n' +
        'pacing interval and expect it to take a while rather than to fail.',
    );
  } else {
    console.log('No limit was stated and nothing was measured. Re-run with --measure.');
  }

  console.log(
    '\nThe importer is resumable: symbols already stored are skipped, so a run that\n' +
      'is interrupted costs nothing to repeat.\n',
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
