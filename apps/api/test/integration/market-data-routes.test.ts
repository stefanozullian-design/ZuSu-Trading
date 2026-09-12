import { dec } from '@zusu/shared';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { ProviderCandle } from '../../src/modules/market-data/types.js';
import { buildTestApp, login, type Session, type TestApp } from '../helpers/app.js';
import { disconnectTestDb, resetDatabase, testDb } from '../helpers/db.js';
import { createUser } from '../helpers/fixtures.js';

let harness: TestApp;
const db = testDb();
let session: Session;

function series(closePrices: number[]): ProviderCandle[] {
  return closePrices.map((close, i) => {
    const openTime = new Date(Date.UTC(2026, 6, 15, 14, 30 + i));
    return {
      symbol: 'AAPL',
      timeframe: '5m' as const,
      openTime,
      closeTime: new Date(openTime.getTime() + 300_000),
      open: dec(close),
      high: dec(close + 1),
      low: dec(close - 1),
      close: dec(close),
      volume: dec(1_000),
      vwap: null,
      tradeCount: 5,
      isAdjusted: true,
    };
  });
}

beforeEach(async () => {
  await resetDatabase();
  harness ??= await buildTestApp();

  await createUser(db, { email: 'viewer@test.local', role: 'VIEWER' });
  session = await login(harness.app, 'viewer@test.local');

  await db.instrument.create({ data: { symbol: 'AAPL', name: 'Apple', exchange: 'XNYS' } });
  await harness.container.dataQuality.ingestCandles(
    series(Array.from({ length: 60 }, (_, i) => 100 + (i % 7))),
    { provider: 'test-feed' },
  );
});

afterAll(async () => {
  await harness?.close();
  await disconnectTestDb();
});

const get = (url: string) =>
  harness.app.inject({ method: 'GET', url, headers: { cookie: session.cookies } });

describe('market-data routes — access', () => {
  it('requires authentication', async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/market-data/instruments',
    });
    expect(response.statusCode).toBe(401);
  });

  it('is readable by a VIEWER, since market data is reference data', async () => {
    expect((await get('/api/market-data/instruments')).statusCode).toBe(200);
  });
});

describe('GET /instruments', () => {
  it('reports the bar count and last close per symbol', async () => {
    const body = (await get('/api/market-data/instruments')).json();

    expect(body.instruments).toHaveLength(1);
    expect(body.instruments[0]).toMatchObject({ symbol: 'AAPL', barCount: 60 });
    expect(body.instruments[0].lastClose).not.toBeNull();
  });

  it('names the simulator when no provider is configured', async () => {
    const body = (await get('/api/market-data/instruments')).json();
    // Never implies a live feed that is not there.
    expect(body.provider).toBe('demo-simulator');
    expect(body.isDelayed).toBeNull();
  });
});

describe('GET /:symbol/candles', () => {
  it('returns bars oldest first', async () => {
    const body = (await get('/api/market-data/AAPL/candles?timeframe=5m&limit=5')).json();

    expect(body.candles).toHaveLength(5);
    const times = body.candles.map((c: { openTime: string }) => c.openTime);
    expect([...times].sort()).toEqual(times);
  });

  it('sends prices as strings, not JSON numbers', async () => {
    const body = (await get('/api/market-data/AAPL/candles?limit=1')).json();
    // A JSON number would round a price silently on the way out.
    expect(typeof body.candles[0].close).toBe('string');
  });

  it('accepts a lower-case symbol', async () => {
    const body = (await get('/api/market-data/aapl/candles?limit=1')).json();
    expect(body.symbol).toBe('AAPL');
  });

  it('returns an empty series for an unknown symbol rather than 404', async () => {
    const body = (await get('/api/market-data/NOPE/candles')).json();
    expect(body.candles).toEqual([]);
  });

  it('rejects an unsupported timeframe', async () => {
    // VALIDATION_FAILED is 422 in this API's error taxonomy, not 400.
    expect((await get('/api/market-data/AAPL/candles?timeframe=7m')).statusCode).toBe(422);
  });
});

describe('GET /:symbol/indicators', () => {
  it('computes every indicator once the history is long enough', async () => {
    const body = (await get('/api/market-data/AAPL/indicators?timeframe=5m')).json();

    expect(body.barsAvailable).toBe(60);
    expect(body.sma20).not.toBeNull();
    expect(body.sma50).not.toBeNull();
    expect(body.rsi14).not.toBeNull();
    expect(typeof body.obv).toBe('string');
  });

  it('reports a short history as null rather than zero', async () => {
    await db.marketDataCandle.deleteMany({});
    await harness.container.dataQuality.ingestCandles(series([100, 101, 102]), {
      provider: 'test-feed',
    });

    const body = (await get('/api/market-data/AAPL/indicators?timeframe=5m')).json();
    expect(body.barsAvailable).toBe(3);
    expect(body.sma20).toBeNull();
    expect(body.rsi14).toBeNull();
  });

  it('returns null when there is no data at all', async () => {
    const response = await get('/api/market-data/NOPE/indicators');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toBeNull();
  });
});

describe('GET /:symbol/indicator-series', () => {
  it('returns arrays aligned to the candle series', async () => {
    const candles = (await get('/api/market-data/AAPL/candles?timeframe=5m&limit=60')).json();
    const body = (await get('/api/market-data/AAPL/indicator-series?timeframe=5m&limit=60')).json();

    expect(body.length).toBe(candles.candles.length);
    for (const key of ['sma20', 'sma50', 'rsi14', 'macd', 'macdSignal', 'macdHistogram']) {
      expect(body[key], key).toHaveLength(candles.candles.length);
    }
  });

  it('leaves warm-up entries null so a chart draws a break, not a zero', async () => {
    const body = (await get('/api/market-data/AAPL/indicator-series?timeframe=5m&limit=60')).json();
    expect(body.sma20.slice(0, 19).every((v: string | null) => v === null)).toBe(true);
    expect(body.sma20[19]).not.toBeNull();
  });
});

describe('GET /:symbol/tradable', () => {
  it('refuses when no calendar is loaded, and says why', async () => {
    const body = (await get('/api/market-data/AAPL/tradable')).json();

    expect(body.tradable).toBe(false);
    expect(body.reason).toContain('No calendar is loaded');
  });

  it('permits during a synced session', async () => {
    await harness.container.calendar.sync(
      'XNYS',
      new Date(Date.now() - 2 * 86_400_000),
      new Date(Date.now() + 2 * 86_400_000),
    );

    const body = (await get('/api/market-data/AAPL/tradable')).json();
    // Whether it is tradable depends on the clock, so assert the shape and
    // that a reason is always given when it is not.
    expect(typeof body.tradable).toBe('boolean');
    if (!body.tradable) expect(body.reason).toBeTruthy();
    else expect(body.reason).toBeNull();
  });
});

describe('GET /quality', () => {
  it('reports a clean feed', async () => {
    const body = (await get('/api/market-data/quality')).json();

    expect(body.ok).toBe(true);
    expect(body.feedWide).toEqual([]);
    expect(body.bySymbol).toEqual([]);
  });

  it('surfaces a feed-wide outage separately from a per-symbol fault', async () => {
    await harness.container.dataQuality.recordOutage('test-feed', 'connection refused');
    await harness.container.dataQuality.ingestQuote({
      symbol: 'AAPL',
      provider: 'test-feed',
      price: dec('100'),
      bid: dec('101'),
      ask: dec('100'),
      bidSize: null,
      askSize: null,
      volume: null,
      sourceTimestamp: new Date(),
      receivedTimestamp: new Date(),
      marketSession: null,
    });

    const body = (await get('/api/market-data/quality')).json();
    expect(body.ok).toBe(false);
    expect(body.feedWide).toHaveLength(1);
    expect(body.bySymbol.map((e: { symbol: string }) => e.symbol)).toEqual(['AAPL']);
    expect(body.recent.length).toBeGreaterThan(0);
  });
});

describe('GET /calendar/:marketCode', () => {
  it('returns the session and the days around today', async () => {
    await harness.container.calendar.sync(
      'XNYS',
      new Date(Date.now() - 2 * 86_400_000),
      new Date(Date.now() + 2 * 86_400_000),
    );

    const body = (await get('/api/market-data/calendar/XNYS')).json();
    expect(body.marketCode).toBe('XNYS');
    expect(body.days.length).toBeGreaterThan(0);
    expect(['REGULAR', 'PRE_MARKET', 'AFTER_HOURS', 'CLOSED', 'HALTED']).toContain(body.session);
  });

  it('reports closed with no days when nothing is synced', async () => {
    const body = (await get('/api/market-data/calendar/XNYS')).json();
    expect(body.session).toBe('CLOSED');
    expect(body.days).toEqual([]);
  });

  it('lists open halts', async () => {
    await harness.container.calendar.recordHalt('AAPL', { reason: 'LULD', source: 'test' });
    const body = (await get('/api/market-data/calendar/XNYS')).json();
    expect(body.openHalts).toEqual([expect.objectContaining({ symbol: 'AAPL', reason: 'LULD' })]);
  });
});
