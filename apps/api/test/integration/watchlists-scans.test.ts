import { dec } from '@zusu/shared';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { ProviderCandle } from '../../src/modules/market-data/types.js';
import { buildTestApp, login, type Session, type TestApp } from '../helpers/app.js';
import { disconnectTestDb, resetDatabase, testDb } from '../helpers/db.js';
import { createUser } from '../helpers/fixtures.js';

let harness: TestApp;
const db = testDb();
let manager: Session;
let viewer: Session;

/** Bars whose closes follow the given path, on a 5m grid. */
function series(symbol: string, closePrices: number[]): ProviderCandle[] {
  return closePrices.map((close, i) => {
    const openTime = new Date(Date.UTC(2026, 6, 15, 14, 30 + i * 5));
    return {
      symbol,
      timeframe: '5m' as const,
      openTime,
      closeTime: new Date(openTime.getTime() + 300_000),
      open: dec(close),
      high: dec(close + 0.5),
      low: dec(close - 0.5),
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

  await createUser(db, { email: 'ops@test.local', role: 'MANAGER' });
  await createUser(db, { email: 'looker@test.local', role: 'VIEWER' });
  manager = await login(harness.app, 'ops@test.local');
  viewer = await login(harness.app, 'looker@test.local');

  for (const symbol of ['AAPL', 'MSFT', 'NVDA']) {
    await db.instrument.create({ data: { symbol, name: symbol, exchange: 'XNYS' } });
  }
});

afterAll(async () => {
  await harness?.close();
  await disconnectTestDb();
});

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

const asManager = (method: Method, url: string, body?: unknown) =>
  harness.app.inject({
    method,
    url,
    headers: manager.headers(),
    ...(body !== undefined && { payload: body }),
  });

const asViewer = (method: Method, url: string, body?: unknown) =>
  harness.app.inject({
    method,
    url,
    headers: viewer.headers(),
    ...(body !== undefined && { payload: body }),
  });

describe('watchlists — permissions', () => {
  it('lets a VIEWER read but not create', async () => {
    expect((await asViewer('GET', '/api/market-data/watchlists')).statusCode).toBe(200);

    const create = await asViewer('POST', '/api/market-data/watchlists', { name: 'Mine' });
    // Reading market data and reconfiguring the platform are different rights.
    expect(create.statusCode).toBe(403);
  });

  it('lets a MANAGER create', async () => {
    const response = await asManager('POST', '/api/market-data/watchlists', { name: 'Momentum' });
    expect(response.statusCode).toBe(201);
  });
});

describe('watchlists — lifecycle', () => {
  it('creates with symbols, ordered deterministically', async () => {
    const created = await asManager('POST', '/api/market-data/watchlists', {
      name: 'Momentum',
      symbols: ['NVDA', 'AAPL'],
    });

    expect(created.statusCode).toBe(201);
    // Symbols added in one bulk create share a timestamp, so they come back
    // alphabetically rather than in the order they were passed — a stable
    // answer instead of whatever order the database returned.
    expect(created.json().symbols).toEqual(['AAPL', 'NVDA']);
  });

  it('appends a later addition after the originals', async () => {
    const id = (
      await asManager('POST', '/api/market-data/watchlists', {
        name: 'Momentum',
        symbols: ['MSFT', 'NVDA'],
      })
    ).json().id as string;

    const added = await asManager('POST', `/api/market-data/watchlists/${id}/symbols`, {
      symbol: 'AAPL',
    });
    // AAPL sorts first alphabetically but was added last, so it goes last.
    expect(added.json().symbols).toEqual(['MSFT', 'NVDA', 'AAPL']);
  });

  it('normalises a lower-case symbol', async () => {
    const created = await asManager('POST', '/api/market-data/watchlists', {
      name: 'Momentum',
      symbols: ['aapl'],
    });
    expect(created.json().symbols).toEqual(['AAPL']);
  });

  it('rejects the whole request when one symbol is unknown', async () => {
    const created = await asManager('POST', '/api/market-data/watchlists', {
      name: 'Momentum',
      symbols: ['AAPL', 'FAKE'],
    });

    expect(created.statusCode).toBe(404);
    expect(created.json().error.message).toContain('FAKE');
    // A watchlist that quietly lost an entry is worse than an error.
    expect(await db.watchlist.count()).toBe(0);
  });

  it('adds and removes symbols', async () => {
    const id = (await asManager('POST', '/api/market-data/watchlists', { name: 'Momentum' })).json()
      .id as string;

    const added = await asManager('POST', `/api/market-data/watchlists/${id}/symbols`, {
      symbol: 'MSFT',
    });
    expect(added.json().symbols).toEqual(['MSFT']);

    const removed = await asManager('DELETE', `/api/market-data/watchlists/${id}/symbols/MSFT`);
    expect(removed.json().symbols).toEqual([]);
  });

  it('treats adding a symbol twice as a no-op', async () => {
    const id = (await asManager('POST', '/api/market-data/watchlists', { name: 'Momentum' })).json()
      .id as string;

    await asManager('POST', `/api/market-data/watchlists/${id}/symbols`, { symbol: 'AAPL' });
    const second = await asManager('POST', `/api/market-data/watchlists/${id}/symbols`, {
      symbol: 'AAPL',
    });

    expect(second.statusCode).toBe(200);
    expect(second.json().symbols).toEqual(['AAPL']);
  });

  it('refuses to watch an unknown symbol', async () => {
    const id = (await asManager('POST', '/api/market-data/watchlists', { name: 'Momentum' })).json()
      .id as string;

    const response = await asManager('POST', `/api/market-data/watchlists/${id}/symbols`, {
      symbol: 'FAKE',
    });
    expect(response.statusCode).toBe(404);
  });

  it('renames and deletes', async () => {
    const id = (await asManager('POST', '/api/market-data/watchlists', { name: 'Momentum' })).json()
      .id as string;

    const renamed = await asManager('PATCH', `/api/market-data/watchlists/${id}`, {
      name: 'Mean reversion',
    });
    expect(renamed.json().name).toBe('Mean reversion');

    expect((await asManager('DELETE', `/api/market-data/watchlists/${id}`)).statusCode).toBe(204);
    expect(await db.watchlist.count()).toBe(0);
  });

  it('protects a system watchlist from rename and delete', async () => {
    const system = await db.watchlist.create({ data: { name: 'Demo universe', isSystem: true } });

    const renamed = await asManager('PATCH', `/api/market-data/watchlists/${system.id}`, {
      name: 'Nope',
    });
    expect(renamed.statusCode).toBe(403);
    expect((await asManager('DELETE', `/api/market-data/watchlists/${system.id}`)).statusCode).toBe(
      403,
    );
  });
});

describe('scans — running an ad-hoc filter', () => {
  beforeEach(async () => {
    // AAPL rises then dips; MSFT rises throughout; NVDA has almost no history.
    await harness.container.dataQuality.ingestCandles(
      series(
        'AAPL',
        Array.from({ length: 60 }, (_, i) => (i < 50 ? 100 + i * 0.4 : 120 - (i - 50) * 2)),
      ),
      { provider: 'test-feed' },
    );
    await harness.container.dataQuality.ingestCandles(
      series(
        'MSFT',
        Array.from({ length: 60 }, (_, i) => 200 + i * 0.5),
      ),
      { provider: 'test-feed' },
    );
    await harness.container.dataQuality.ingestCandles(series('NVDA', [500, 501, 502]), {
      provider: 'test-feed',
    });
  });

  it('is readable by a VIEWER — running a scan changes nothing', async () => {
    const response = await asViewer('POST', '/api/market-data/scans/run', {
      timeframe: '5m',
      conditions: [{ field: 'close', operator: 'gt', operand: { constant: '0' } }],
    });
    expect(response.statusCode).toBe(200);
  });

  it('matches on a field-to-field comparison and explains each match', async () => {
    const body = (
      await asManager('POST', '/api/market-data/scans/run', {
        timeframe: '5m',
        conditions: [{ field: 'close', operator: 'gt', operand: { field: 'sma20' } }],
      })
    ).json();

    expect(body.matches.map((m: { symbol: string }) => m.symbol)).toEqual(['MSFT']);
    // The values that produced the match travel with it.
    expect(body.matches[0].values).toHaveProperty('close');
    expect(body.matches[0].values).toHaveProperty('sma20');
    expect(body.summary).toEqual(['close above sma20']);
  });

  it('reports a short-history symbol as not evaluable, not as a non-match', async () => {
    const body = (
      await asManager('POST', '/api/market-data/scans/run', {
        timeframe: '5m',
        conditions: [{ field: 'sma50', operator: 'gt', operand: { constant: '1' } }],
      })
    ).json();

    const nvda = body.notEvaluable.find((s: { symbol: string }) => s.symbol === 'NVDA');
    expect(nvda.missingField).toBe('sma50');
    expect(nvda.reason).toContain('warm-up');
    // "No matches" and "not enough data" must be distinguishable.
    expect(body.matches.map((m: { symbol: string }) => m.symbol)).not.toContain('NVDA');
  });

  it('scopes the universe to a watchlist when one is given', async () => {
    const id = (
      await asManager('POST', '/api/market-data/watchlists', {
        name: 'Just Apple',
        symbols: ['AAPL'],
      })
    ).json().id as string;

    const body = (
      await asManager('POST', '/api/market-data/scans/run', {
        timeframe: '5m',
        watchlistId: id,
        conditions: [{ field: 'close', operator: 'gt', operand: { constant: '0' } }],
      })
    ).json();

    expect(body.universe).toEqual(['AAPL']);
  });

  it('scans every instrument when no watchlist is given', async () => {
    const body = (
      await asManager('POST', '/api/market-data/scans/run', {
        timeframe: '5m',
        conditions: [],
      })
    ).json();
    expect(body.universe.sort()).toEqual(['AAPL', 'MSFT', 'NVDA']);
  });

  it('rejects an unknown field', async () => {
    const response = await asManager('POST', '/api/market-data/scans/run', {
      timeframe: '5m',
      conditions: [{ field: 'moon_phase', operator: 'gt', operand: { constant: '1' } }],
    });
    expect(response.statusCode).toBe(422);
  });

  it('rejects a threshold that is not a number', async () => {
    const response = await asManager('POST', '/api/market-data/scans/run', {
      timeframe: '5m',
      conditions: [{ field: 'rsi14', operator: 'lt', operand: { constant: 'thirty' } }],
    });

    // Refused at the edge rather than left to the evaluator, where it would
    // surface as "no symbol could be evaluated" — indistinguishable from
    // missing market data.
    expect(response.statusCode).toBe(422);
  });

  it('rejects between without an upper bound', async () => {
    const response = await asManager('POST', '/api/market-data/scans/run', {
      timeframe: '5m',
      conditions: [{ field: 'rsi14', operator: 'between', operand: { constant: '30' } }],
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.message).toContain('upper bound');
  });
});

describe('scans — saved definitions', () => {
  const oversold = {
    name: 'Oversold',
    timeframe: '5m' as const,
    conditions: [{ field: 'rsi14', operator: 'lt', operand: { constant: '35' } }],
  };

  it('saves, lists and renders a readable summary', async () => {
    const created = await asManager('POST', '/api/market-data/scans', oversold);
    expect(created.statusCode).toBe(201);
    expect(created.json().summary).toEqual(['rsi14 below 35']);

    const list = (await asManager('GET', '/api/market-data/scans')).json();
    expect(list.scans).toHaveLength(1);
  });

  it('records who created it', async () => {
    const created = await asManager('POST', '/api/market-data/scans', oversold);
    const row = await db.scanDefinition.findUniqueOrThrow({
      where: { id: created.json().id as string },
    });
    expect(row.createdBy).not.toBeNull();
  });

  it('refuses a duplicate name', async () => {
    await asManager('POST', '/api/market-data/scans', oversold);
    const second = await asManager('POST', '/api/market-data/scans', oversold);
    expect(second.statusCode).toBe(409);
  });

  it('edits conditions and re-renders the summary', async () => {
    const id = (await asManager('POST', '/api/market-data/scans', oversold)).json().id as string;

    const updated = await asManager('PATCH', `/api/market-data/scans/${id}`, {
      conditions: [{ field: 'close', operator: 'crosses_above', operand: { field: 'sma20' } }],
    });
    expect(updated.json().summary).toEqual(['close crosses above sma20']);
  });

  it('deletes', async () => {
    const id = (await asManager('POST', '/api/market-data/scans', oversold)).json().id as string;
    expect((await asManager('DELETE', `/api/market-data/scans/${id}`)).statusCode).toBe(204);
    expect(await db.scanDefinition.count()).toBe(0);
  });

  it('runs a saved scan and records when it last ran', async () => {
    await harness.container.dataQuality.ingestCandles(
      series(
        'AAPL',
        Array.from({ length: 40 }, (_, i) => 100 - i),
      ),
      { provider: 'test-feed' },
    );

    const id = (await asManager('POST', '/api/market-data/scans', oversold)).json().id as string;
    const run = await asManager('POST', `/api/market-data/scans/${id}/run`, {});

    expect(run.statusCode).toBe(200);
    expect(run.json().matches.map((m: { symbol: string }) => m.symbol)).toContain('AAPL');

    const row = await db.scanDefinition.findUniqueOrThrow({ where: { id } });
    expect(row.lastRunAt).not.toBeNull();
  });

  it('404s for an unknown scan', async () => {
    const missing = '00000000-0000-4000-8000-000000000000';
    expect((await asManager('POST', `/api/market-data/scans/${missing}/run`, {})).statusCode).toBe(
      404,
    );
  });

  it('refuses to read a stored scan whose conditions no longer validate', async () => {
    const id = (await asManager('POST', '/api/market-data/scans', oversold)).json().id as string;
    // Simulate a shape this version cannot parse.
    await db.$executeRawUnsafe(
      `UPDATE scan_definitions SET conditions = '[{"field":"not_a_field"}]'::jsonb WHERE id = $1::uuid`,
      id,
    );

    const response = await asManager('GET', '/api/market-data/scans');
    // Half-evaluating a filter would return matches against criteria nobody
    // chose, so the honest outcome is to refuse.
    expect(response.statusCode).toBe(500);
  });
});
