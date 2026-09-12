import { StrategyStage, dec } from '@zusu/shared';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { MarketDataQualityService } from '../../src/modules/market-data/quality.service.js';
import type { ProviderCandle } from '../../src/modules/market-data/types.js';
import {
  buildTestApp,
  login,
  sessionFromResponse,
  type Session,
  type TestApp,
} from '../helpers/app.js';
import { disconnectTestDb, resetDatabase, testDb } from '../helpers/db.js';
import { TEST_PASSWORD, createPortfolio, createUser } from '../helpers/fixtures.js';
import { currentTotp } from '../../src/modules/auth/mfa.js';

/**
 * Backtests over HTTP.
 *
 * The assertions worth having here are about what a stored result carries: the
 * costs and assumptions it was run under, its trades, and the counts that
 * qualify it. A backtest is a claim about the past, and a claim without its
 * assumptions cannot be checked six months later.
 */

let harness: TestApp;
const db = testDb();
let manager: Session;
let viewer: Session;
let versionId: string;
let strategyId: string;

const BAR_MS = 300_000;
const START = Date.UTC(2026, 5, 1, 14, 0);
const WINDOW = {
  from: new Date(START - BAR_MS).toISOString(),
  to: new Date(START + 400 * BAR_MS).toISOString(),
};

/**
 * A sawtooth: up for five bars, down for five. A "close above 102" rule fires
 * repeatedly, so a run produces a double-digit number of trades rather than
 * one — which is what makes the metrics worth asserting on.
 */
function sawtooth(symbol: string, length: number): ProviderCandle[] {
  return Array.from({ length }, (_, i) => {
    const phase = i % 10;
    const level = 100 + (phase < 5 ? phase : 10 - phase) * 2;
    const next = 100 + (phase + 1 < 5 ? phase + 1 : 10 - (phase + 1)) * 2;
    const openTime = new Date(START + i * BAR_MS);
    return {
      symbol,
      timeframe: '5m' as const,
      openTime,
      closeTime: new Date(openTime.getTime() + BAR_MS),
      open: dec(level),
      high: dec(Math.max(level, next) + 0.5),
      low: dec(Math.min(level, next) - 0.5),
      close: dec(next),
      volume: dec(1_000),
      vwap: null,
      tradeCount: 10,
      isAdjusted: true,
    };
  });
}

const definition = {
  timeframe: '5m',
  watchlistId: null,
  entry: {
    direction: 'LONG',
    when: { type: 'condition', field: 'close', operator: 'gt', operand: { constant: '102' } },
  },
  exit: null,
  stop: { kind: 'PERCENT', value: '2' },
  target: { kind: 'PERCENT', value: '3' },
};

const riskSettings = { maxConcurrentPositions: 1, maxNotionalPerTrade: '10000', minBars: 2 };

beforeEach(async () => {
  await resetDatabase();
  harness ??= await buildTestApp();

  await createUser(db, { email: 'quant@test.local', role: 'ADMIN' });
  await createUser(db, { email: 'ops@test.local', role: 'MANAGER' });
  await createUser(db, { email: 'looker@test.local', role: 'VIEWER' });
  manager = await login(harness.app, 'ops@test.local');
  viewer = await login(harness.app, 'looker@test.local');
  await createPortfolio(db, { name: 'Alpha' });

  await db.instrument.create({ data: { symbol: 'AAPL', name: 'Apple', exchange: 'XNYS' } });
  await new MarketDataQualityService(db).ingestCandles(sawtooth('AAPL', 400), {
    provider: 'test-feed',
  });

  const created = await harness.app.inject({
    method: 'POST',
    url: '/api/strategies',
    headers: manager.headers(),
    payload: {
      name: 'Sawtooth rider',
      definition,
      riskSettings,
      changeDescription: 'a rule that fires often enough to measure',
    },
  });
  const strategy = created.json() as { id: string; versions: { id: string }[] };
  strategyId = strategy.id;
  versionId = strategy.versions[0]!.id;
});

afterAll(async () => {
  await harness?.close();
  await disconnectTestDb();
});

/** An admin session, enrolling in MFA on the way as the role demands. */
async function loginAdmin(): Promise<Session> {
  const challenge = await harness.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email: 'quant@test.local', password: TEST_PASSWORD },
  });
  const { mfaToken } = challenge.json();
  const enrol = await harness.app.inject({
    method: 'POST',
    url: '/api/auth/mfa/enrol',
    payload: { mfaToken },
  });
  const verify = await harness.app.inject({
    method: 'POST',
    url: '/api/auth/mfa/verify',
    payload: { mfaToken, totp: currentTotp(enrol.json().secret) },
  });
  return sessionFromResponse(verify.cookies, verify.json().csrfToken);
}

const asManager = (method: 'GET' | 'POST', url: string, body?: unknown) =>
  harness.app.inject({
    method,
    url,
    headers: manager.headers(),
    ...(body !== undefined && { payload: body }),
  });

const runBacktest = (overrides: Record<string, unknown> = {}) =>
  asManager('POST', '/api/backtests', {
    strategyVersionId: versionId,
    ...WINDOW,
    initialCapital: '100000',
    quick: true,
    ...overrides,
  });

describe('permissions', () => {
  it('refuses a viewer', async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/backtests',
      headers: viewer.headers(),
    });
    expect(response.statusCode).toBe(403);
  });

  it('lets a manager run one', async () => {
    expect((await runBacktest()).statusCode).toBe(201);
  });

  it('records who asked for it', async () => {
    const admin = await loginAdmin();
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/backtests',
      headers: admin.headers(),
      payload: { strategyVersionId: versionId, ...WINDOW, quick: true },
    });
    expect(response.statusCode).toBe(201);

    const row = await db.backtest.findFirstOrThrow({ include: { requestedBy: true } });
    expect(row.requestedBy?.email).toBe('quant@test.local');
  });
});

describe('a completed run', () => {
  it('takes trades and reports them net of costs', async () => {
    const response = await runBacktest();
    const body = response.json() as {
      id: string;
      status: string;
      tradeCount: number;
      metrics: Record<string, string>;
    };

    expect(body.status).toBe('COMPLETED');
    expect(body.tradeCount).toBeGreaterThan(5);
    // Costs are charged by default, so gross always exceeds net.
    expect(dec(body.metrics.grossProfit!).greaterThan(dec(body.metrics.netProfit!))).toBe(true);
    expect(dec(body.metrics.feesPaid!).greaterThan(0)).toBe(true);
  });

  it('stores its assumptions with the result', async () => {
    const response = await runBacktest();
    const body = response.json() as {
      parameters: { assumptions: string[]; costs: Record<string, string>; universe: string[] };
    };

    // A result read later without its assumptions is a number with no claim
    // attached, so they travel with it.
    expect(body.parameters.assumptions.join(' ')).toContain('next bar’s open');
    expect(body.parameters.assumptions.join(' ')).toContain('gaps through it');
    expect(body.parameters.costs.spreadFraction).toBeTruthy();
    expect(body.parameters.universe).toEqual(['AAPL']);
  });

  it('stores every trade, with its fees and its reason for ending', async () => {
    const created = await runBacktest();
    const id = (created.json() as { id: string }).id;

    const response = await asManager('GET', `/api/backtests/${id}`);
    const body = response.json() as {
      trades: { symbol: string; fees: string; exitReason: string; netPnl: string }[];
    };

    expect(body.trades.length).toBeGreaterThan(5);
    for (const trade of body.trades) {
      expect(trade.symbol).toBe('AAPL');
      // Decimals cross the wire as strings, so no float ever rounds them.
      expect(typeof trade.netPnl).toBe('string');
      expect(dec(trade.fees).greaterThan(0)).toBe(true);
      expect(['STOP', 'TARGET', 'RULE', 'END_OF_DATA']).toContain(trade.exitReason);
    }
  });

  it('carries the caveats that qualify the result', async () => {
    const response = await runBacktest();
    const body = response.json() as { metrics: { caveats: Record<string, unknown> } };

    expect(body.metrics.caveats).toMatchObject({
      ambiguousExits: expect.any(Number),
      gapThroughStop: expect.any(Number),
      unknownVerdicts: expect.any(Number),
      ratiosSuppressed: expect.any(Boolean),
    });
  });

  it('runs walk-forward and Monte Carlo when not asked to be quick', async () => {
    const response = await runBacktest({ quick: false, monteCarloSeed: 11 });
    const body = response.json() as {
      walkForward: { folds: unknown[]; verdict: string };
      monteCarlo: { iterations: number; verdict: string };
    };

    expect(body.walkForward.verdict).toBeTruthy();
    expect(body.monteCarlo.iterations).toBeGreaterThan(0);
    expect(body.monteCarlo.verdict).toContain('Size the position');
  });

  it('is reproducible: the same seed gives the same Monte Carlo', async () => {
    const first = (await runBacktest({ quick: false, monteCarloSeed: 5 })).json() as {
      monteCarlo: { equityPercentiles: Record<string, string> };
    };
    const second = (await runBacktest({ quick: false, monteCarloSeed: 5 })).json() as {
      monteCarlo: { equityPercentiles: Record<string, string> };
    };

    expect(first.monteCarlo.equityPercentiles).toEqual(second.monteCarlo.equityPercentiles);
  });

  it('names the version, so the run stays reproducible after the strategy changes', async () => {
    const created = await runBacktest();
    const id = (created.json() as { id: string }).id;

    await asManager('POST', `/api/strategies/${strategyId}/versions`, {
      definition: {
        ...definition,
        entry: {
          direction: 'LONG',
          when: { type: 'condition', field: 'close', operator: 'gt', operand: { constant: '108' } },
        },
      },
      riskSettings,
      changeDescription: 'a completely different threshold',
    });

    const reread = await asManager('GET', `/api/backtests/${id}`);
    // Still pinned to version 1, whose definition can never change.
    expect((reread.json() as { version: number }).version).toBe(1);
  });
});

describe('a run it cannot make', () => {
  it('fails with a reason when the window holds no bars', async () => {
    const response = await runBacktest({
      from: new Date(Date.UTC(2020, 0, 1)).toISOString(),
      to: new Date(Date.UTC(2020, 0, 5)).toISOString(),
    });

    const body = response.json() as { status: string; errorMessage: string };
    // An empty backtest is not a flat result, and it does not get to look like one.
    expect(body.status).toBe('FAILED');
    expect(body.errorMessage).toContain('Backfill the history first');
  });

  it('refuses a window that ends before it starts', async () => {
    const response = await runBacktest({ from: WINDOW.to, to: WINDOW.from });
    expect(response.statusCode).toBe(422);
  });

  it('404s on an unknown version', async () => {
    const response = await runBacktest({
      strategyVersionId: '00000000-0000-4000-8000-000000000000',
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('optimisation', () => {
  const candidate = (level: number) => ({
    label: `close above ${String(level)}`,
    definition: {
      ...definition,
      entry: {
        direction: 'LONG',
        when: {
          type: 'condition',
          field: 'close',
          operator: 'gt',
          operand: { constant: String(level) },
        },
      },
    },
  });

  it('ranks candidates and always warns about the search itself', async () => {
    const response = await asManager('POST', '/api/backtests/optimise', {
      strategyVersionId: versionId,
      ...WINDOW,
      candidates: [100, 102, 104, 106].map(candidate),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      candidates: { label: string; score: string }[];
      best: { label: string };
      warnings: string[];
    };
    expect(body.candidates).toHaveLength(4);
    expect(body.best.label).toBe(body.candidates[0]!.label);
    expect(body.warnings.join(' ')).toContain('parameter sets were tried');
  });

  it('stores nothing, because a search of the past does not get to choose the rules', async () => {
    await asManager('POST', '/api/backtests/optimise', {
      strategyVersionId: versionId,
      ...WINDOW,
      candidates: [100, 102].map(candidate),
    });

    expect(await db.backtest.count()).toBe(0);
    // And the strategy still has exactly the one version a person wrote.
    expect(await db.strategyVersion.count()).toBe(1);
  });

  it('refuses an empty candidate list', async () => {
    const response = await asManager('POST', '/api/backtests/optimise', {
      strategyVersionId: versionId,
      ...WINDOW,
      candidates: [],
    });
    expect(response.statusCode).toBe(422);
  });
});

describe('backtesting a live version', () => {
  it('is allowed at any stage, because a backtest cannot place an order', async () => {
    const admin = await loginAdmin();
    for (const stage of [
      StrategyStage.BACKTEST,
      StrategyStage.PAPER,
      StrategyStage.REVIEW,
      StrategyStage.APPROVED,
      StrategyStage.LIVE,
    ]) {
      await harness.app.inject({
        method: 'POST',
        url: `/api/strategies/versions/${versionId}/promote`,
        headers: admin.headers(),
        payload: { stage },
      });
    }

    const response = await runBacktest();
    expect(response.statusCode).toBe(201);
    expect(await db.order.count()).toBe(0);
    expect(await db.signal.count()).toBe(0);
  });
});

describe('the window a result describes', () => {
  it('reads the whole requested window rather than the newest few hundred bars', async () => {
    // The candle loader defaults to the newest 500 bars when no range is
    // given. A backtest that inherited that default would label a five-day
    // result as a month — so a ranged load is not trimmed.
    const response = await runBacktest();
    const body = response.json() as { parameters: { barsLoaded: number } };

    expect(body.parameters.barsLoaded).toBe(400);
  });

  it('reports the span the bars actually cover, not the span requested', async () => {
    const response = await runBacktest({
      from: new Date(START - 50 * 86_400_000).toISOString(),
      to: new Date(START + 500 * BAR_MS).toISOString(),
    });
    const body = response.json() as {
      parameters: { windowUsed: { from: string; to: string } | null };
    };

    // Stored history starts at the first fixture bar, not fifty days earlier.
    expect(body.parameters.windowUsed?.from).toBe(new Date(START).toISOString());
    expect(body.parameters.windowUsed?.to).toBe(new Date(START + 399 * BAR_MS).toISOString());
  });
});
