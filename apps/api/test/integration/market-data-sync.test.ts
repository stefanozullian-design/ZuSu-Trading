import { dec } from '@zusu/shared';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MarketCalendarService } from '../../src/modules/market-data/calendar.service.js';
import { MarketDataSyncService } from '../../src/modules/market-data/market-data-sync.service.js';
import { MarketDataProviderRegistry } from '../../src/modules/market-data/provider-registry.js';
import { MarketDataQualityService } from '../../src/modules/market-data/quality.service.js';
import { MarketDataError } from '../../src/modules/market-data/types.js';
import type { MarketDataProvider, ProviderCandle } from '../../src/modules/market-data/types.js';
import { disconnectTestDb, resetDatabase, testDb } from '../helpers/db.js';

/**
 * Fetching real bars into the database.
 *
 * The rule worth defending: when the provider cannot answer, nothing is
 * invented. A platform that quietly substitutes generated prices for a feed it
 * could not reach is worse than one with no data at all, because the screen
 * looks identical either way.
 */

const db = testDb();
let sync: MarketDataSyncService;
let providers: MarketDataProviderRegistry;
let quality: MarketDataQualityService;

const FROM = new Date('2026-08-03T00:00:00Z');

function dailyBars(symbol: string, count: number): ProviderCandle[] {
  return Array.from({ length: count }, (_, i) => {
    const openTime = new Date(FROM.getTime() + i * 86_400_000);
    const price = 100 + i;
    return {
      symbol,
      timeframe: '1d' as const,
      openTime,
      closeTime: new Date(openTime.getTime() + 86_400_000),
      open: dec(price),
      high: dec(price + 1),
      low: dec(price - 1),
      close: dec(price + 0.5),
      volume: dec(1_000_000),
      vwap: null,
      tradeCount: 5_000,
      isAdjusted: true,
    };
  });
}

/** A provider whose answers the test dictates. */
function fakeProvider(behaviour: {
  candles?: ProviderCandle[];
  throws?: Error;
}): MarketDataProvider {
  return {
    kind: 'FIXTURE',
    name: 'massive',
    isDelayed: true,
    getQuote: () => Promise.reject(new Error('not used')),
    getQuotes: () => Promise.reject(new Error('not used')),
    getCandles: () =>
      behaviour.throws
        ? Promise.reject(behaviour.throws)
        : Promise.resolve(behaviour.candles ?? []),
    getCorporateActions: () => Promise.resolve([]),
    searchInstruments: () => Promise.resolve([]),
    getCalendar: () => Promise.resolve([]),
    healthCheck: () =>
      Promise.resolve({ ok: true, latencyMs: 1, detail: null, rateLimitRemaining: null }),
  } as unknown as MarketDataProvider;
}

function useProvider(provider: MarketDataProvider | null): void {
  vi.spyOn(providers, 'tryResolve').mockReturnValue(provider);
  if (provider) vi.spyOn(providers, 'resolve').mockReturnValue(provider);
}

beforeEach(async () => {
  await resetDatabase();
  providers = new MarketDataProviderRegistry();
  quality = new MarketDataQualityService(db);
  const calendar = new MarketCalendarService(db);
  sync = new MarketDataSyncService(db, providers, quality, calendar);

  await db.instrument.create({
    data: { symbol: 'AAPL', name: 'Apple', exchange: 'XNYS', sector: 'Technology' },
  });
  await db.instrument.create({
    data: { symbol: 'MSFT', name: 'Microsoft', exchange: 'XNYS', sector: 'Technology' },
  });
});

afterAll(async () => {
  vi.restoreAllMocks();
  await disconnectTestDb();
});

describe('syncing real bars', () => {
  it('stores what the provider returns, tagged with the provider', async () => {
    useProvider(fakeProvider({ candles: dailyBars('AAPL', 10) }));

    const run = await sync.sync({ symbols: ['AAPL'], timeframe: '1d', pacingMs: 0 });

    expect(run.results[0]?.status).toBe('STORED');
    expect(run.results[0]?.stored).toBe(10);

    const stored = await db.marketDataCandle.findMany({ take: 1 });
    // Real rows say who produced them, so nothing downstream can mistake them
    // for the simulator's output.
    expect(stored[0]?.provider).toBe('massive');
  });

  it('runs the same inspection real bars deserve as much as invented ones', async () => {
    // A bar whose low is above its high cannot have happened.
    const impossible = dailyBars('AAPL', 3);
    impossible[1] = { ...impossible[1]!, low: dec(500), high: dec(1) };
    useProvider(fakeProvider({ candles: impossible }));

    const run = await sync.sync({ symbols: ['AAPL'], timeframe: '1d', pacingMs: 0 });

    expect(run.results[0]?.findings.length).toBeGreaterThan(0);
    expect(run.results[0]?.findings.join(' ')).toMatch(/IMPOSSIBLE|impossible/i);
  });

  it('reports a provider failure and invents nothing', async () => {
    useProvider(fakeProvider({ throws: new MarketDataError('rate limit exceeded', true, 429) }));

    const run = await sync.sync({ symbols: ['AAPL'], timeframe: '1d', pacingMs: 0 });

    expect(run.results[0]?.status).toBe('FAILED');
    expect(run.results[0]?.detail).toContain('rate limit exceeded');
    expect(run.results[0]?.detail).toContain('retryable');
    // The whole point: no bars appeared from somewhere else.
    expect(await db.marketDataCandle.count()).toBe(0);
  });

  it('carries on to the next symbol after one fails', async () => {
    let call = 0;
    const provider = fakeProvider({});
    vi.spyOn(provider, 'getCandles').mockImplementation(() => {
      call += 1;
      return call === 1
        ? Promise.reject(new MarketDataError('boom', false))
        : Promise.resolve(dailyBars('MSFT', 4));
    });
    useProvider(provider);

    const run = await sync.sync({ symbols: ['AAPL', 'MSFT'], timeframe: '1d', pacingMs: 0 });

    expect(run.results[0]?.status).toBe('FAILED');
    expect(run.results[1]?.status).toBe('STORED');
    expect(run.summary).toContain('1 failed: AAPL');
  });

  it('explains an empty answer as the plan rather than a fault', async () => {
    useProvider(fakeProvider({ candles: [] }));

    const run = await sync.sync({ symbols: ['AAPL'], timeframe: '5m', pacingMs: 0 });

    expect(run.results[0]?.status).toBe('NOTHING_RETURNED');
    // The overwhelmingly likely cause on a free plan, and saying so saves
    // somebody an hour of looking for a bug that is not there.
    expect(run.results[0]?.detail).toContain('without intraday data');
  });

  it('refuses to run at all with no provider configured', async () => {
    useProvider(null);
    vi.spyOn(providers, 'resolve').mockImplementation(() => {
      throw new Error('No market-data provider is configured.');
    });

    await expect(sync.sync({ symbols: ['AAPL'], pacingMs: 0 })).rejects.toThrow(
      /No market-data provider is configured/,
    );
  });

  it('syncs every tradable instrument when given no symbol list', async () => {
    useProvider(fakeProvider({ candles: dailyBars('AAPL', 2) }));
    const symbols = await sync.syncableSymbols();
    expect(symbols).toEqual(['AAPL', 'MSFT']);
  });
});
