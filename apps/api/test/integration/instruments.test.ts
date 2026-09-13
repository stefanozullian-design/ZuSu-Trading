import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { UserRole } from '@zusu/shared';
import { buildTestApp, login, type Session, type TestApp } from '../helpers/app.js';
import { disconnectTestDb, resetDatabase, testDb } from '../helpers/db.js';
import { createUser } from '../helpers/fixtures.js';
import type {
  MarketDataProvider,
  ProviderInstrument,
} from '../../src/modules/market-data/types.js';

/**
 * Teaching the platform a symbol it does not know.
 *
 * Before this, the only instruments that existed were the eight the demo seed
 * writes, and nothing in the application could add a ninth — not the import,
 * not a watchlist, which requires a known instrument too. An installation with
 * a real feed could still only hold AAPL and seven others, and the import's
 * advice to "add it to a watchlist first" described a route that did not
 * exist.
 *
 * The property under test is that the provider decides. A symbol written down
 * because somebody typed it would chart as a gap, mark as a dash and fail
 * every risk check with a message about missing data rather than about a
 * ticker that was never real.
 */

let harness: TestApp;
const db = testDb();
let session: Session;

function instrument(symbol: string, name: string): ProviderInstrument {
  return {
    symbol,
    name,
    assetClass: 'EQUITY',
    marketCode: 'XNAS',
    sector: 'Technology',
    isActive: true,
  };
}

function useProvider(found: ProviderInstrument[] | null): void {
  const provider =
    found === null
      ? null
      : ({
          kind: 'FIXTURE',
          name: 'massive',
          isDelayed: true,
          getQuote: () => Promise.reject(new Error('not used')),
          getQuotes: () => Promise.reject(new Error('not used')),
          getCandles: () => Promise.resolve([]),
          getCorporateActions: () => Promise.resolve([]),
          searchInstruments: () => Promise.resolve(found),
          getCalendar: () => Promise.resolve([]),
          healthCheck: () =>
            Promise.resolve({ ok: true, latencyMs: 1, detail: null, rateLimitRemaining: null }),
        } as unknown as MarketDataProvider);

  vi.spyOn(harness.container.marketData, 'tryResolve').mockReturnValue(provider);
  if (provider) vi.spyOn(harness.container.marketData, 'resolve').mockReturnValue(provider);
}

beforeEach(async () => {
  await resetDatabase();
  harness ??= await buildTestApp();
  vi.restoreAllMocks();
  await createUser(db, { email: 'pm@test.local', role: UserRole.MANAGER });
  session = await login(harness.app, 'pm@test.local');
});

afterAll(async () => {
  vi.restoreAllMocks();
  await harness?.close();
  await disconnectTestDb();
});

async function add(symbol: string) {
  return harness.app.inject({
    method: 'POST',
    url: '/api/market-data/instruments',
    headers: session.headers(),
    payload: { symbol },
  });
}

describe('adding a symbol', () => {
  it('records one the provider confirms', async () => {
    useProvider([instrument('CRDO', 'Credo Technology Group Holding Ltd')]);

    const response = await add('crdo');

    expect(response.statusCode).toBe(201);
    expect(response.json().symbol).toBe('CRDO');
    expect(response.json().name).toMatch(/Credo/);

    const stored = await db.instrument.findUnique({ where: { symbol: 'CRDO' } });
    expect(stored?.exchange).toBe('XNAS');
  });

  it('refuses one the provider has never heard of', async () => {
    useProvider([]);

    const response = await add('ZZQQX');

    // Naming the provider matters: the useful information is that Massive has
    // no such symbol, not that this platform is missing something.
    expect(response.statusCode).toBe(404);
    expect(response.json().error.message).toMatch(/massive has no instrument/i);
    expect(await db.instrument.findFirst({ where: { symbol: 'ZZQQX' } })).toBeNull();
  });

  it('refuses a near miss rather than taking the closest match', async () => {
    // A search for CRDO that returns CRD.A is not a confirmation of CRDO, and
    // accepting it would file a holding under a company nobody chose.
    useProvider([instrument('CRD.A', 'Crawford & Company')]);

    const response = await add('CRDO');

    expect(response.statusCode).toBe(404);
    expect(await db.instrument.findFirst({ where: { symbol: 'CRDO' } })).toBeNull();
  });

  it('refuses when there is no provider at all', async () => {
    useProvider(null);

    const response = await add('CRDO');

    // An instrument nobody can price is worse than an absent one.
    expect(response.statusCode).toBe(503);
    expect(await db.instrument.findFirst({ where: { symbol: 'CRDO' } })).toBeNull();
  });

  it('refuses a symbol it already knows rather than creating a second', async () => {
    useProvider([instrument('CRDO', 'Credo')]);
    await add('CRDO');

    const again = await add('CRDO');

    expect(again.statusCode).toBe(409);
  });

  it('rejects something that is not the shape of a ticker', async () => {
    useProvider([instrument('CRDO', 'Credo')]);

    expect((await add('not a ticker!')).statusCode).toBe(422);
  });

  it('does not let a viewer add one', async () => {
    useProvider([instrument('CRDO', 'Credo')]);
    await createUser(db, { email: 'v@test.local', role: UserRole.VIEWER });
    const viewer = await login(harness.app, 'v@test.local');

    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/market-data/instruments',
      headers: viewer.headers(),
      payload: { symbol: 'CRDO' },
    });

    expect(response.statusCode).toBe(403);
  });
});

describe('searching for a symbol', () => {
  it('returns what the provider knows by that name', async () => {
    useProvider([instrument('SNOW', 'Snowflake Inc')]);

    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/market-data/instruments/search?q=snow',
      headers: session.headers(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().results[0].symbol).toBe('SNOW');
  });
});
