import { StrategyStage, dec } from '@zusu/shared';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { MarketCalendarService } from '../../src/modules/market-data/calendar.service.js';
import { MarketDataQualityService } from '../../src/modules/market-data/quality.service.js';
import type { ProviderCandle } from '../../src/modules/market-data/types.js';
import type { RuleNode } from '../../src/modules/strategies/rule-tree.js';
import {
  buildTestApp,
  login,
  sessionFromResponse,
  type Session,
  type TestApp,
} from '../helpers/app.js';
import { currentTotp } from '../../src/modules/auth/mfa.js';
import { disconnectTestDb, resetDatabase, testDb } from '../helpers/db.js';
import { TEST_PASSWORD, createPortfolio, createUser } from '../helpers/fixtures.js';

/**
 * The strategy API over HTTP (§10, §11).
 *
 * These tests care about what the boundary guarantees rather than what the
 * services compute — the service tests cover the rule engine. Three things
 * matter here: who is allowed to do what, that a definition really is
 * immutable through the API too, and that no route can turn a signal into an
 * order.
 */

let harness: TestApp;
const db = testDb();
let admin: Session;
let manager: Session;
let viewer: Session;
let portfolioId: string;

/** A Wednesday inside a regular session, so the calendar permits trading. */
const SESSION_DAY = new Date('2026-07-15T00:00:00.000Z');
const BAR_START = Date.UTC(2026, 6, 15, 14, 0); // 10:00 New York
const EVALUATE_AT = new Date(BAR_START + 59 * 300_000).toISOString();

const rsiBelow = (value: number): RuleNode => ({
  type: 'condition',
  field: 'rsi14',
  operator: 'lt',
  operand: { constant: String(value) },
});

function definition(overrides: Record<string, unknown> = {}) {
  return {
    timeframe: '5m',
    watchlistId: null,
    entry: { direction: 'LONG', when: rsiBelow(90) },
    exit: null,
    stop: { kind: 'PERCENT', value: '2' },
    target: { kind: 'RISK_MULTIPLE', value: '2' },
    ...overrides,
  };
}

const riskSettings = {
  maxConcurrentPositions: 3,
  maxNotionalPerTrade: '10000',
  minBars: 30,
};

/** Declining closes, so RSI ends low and a "rsi below" rule fires. */
function decliningBars(symbol: string, count: number): ProviderCandle[] {
  return Array.from({ length: count }, (_, i) => {
    const openTime = new Date(BAR_START + i * 300_000);
    const close = 200 - i * 0.5;
    return {
      symbol,
      timeframe: '5m' as const,
      openTime,
      closeTime: new Date(openTime.getTime() + 300_000),
      open: dec(close),
      high: dec(close + 0.4),
      low: dec(close - 0.4),
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

  await createUser(db, { email: 'quant@test.local', role: 'ADMIN' });
  await createUser(db, { email: 'ops@test.local', role: 'MANAGER' });
  await createUser(db, { email: 'looker@test.local', role: 'VIEWER' });
  admin = await loginAdmin('quant@test.local');
  manager = await login(harness.app, 'ops@test.local');
  viewer = await login(harness.app, 'looker@test.local');

  const portfolio = await createPortfolio(db, { name: 'Alpha' });
  portfolioId = portfolio.id;

  const calendar = new MarketCalendarService(db);
  await calendar.sync('XNYS', SESSION_DAY, new Date('2026-07-16T00:00:00.000Z'));
  await db.instrument.create({ data: { symbol: 'AAPL', name: 'Apple', exchange: 'XNYS' } });
  await new MarketDataQualityService(db).ingestCandles(decliningBars('AAPL', 60), {
    provider: 'test-feed',
  });
});

/**
 * Signs in an administrator, enrolling in MFA on the way. An admin session
 * without a second factor is not a thing this platform issues, so the test
 * has to go through the same door a person does.
 */
async function loginAdmin(email: string): Promise<Session> {
  const challenge = await harness.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password: TEST_PASSWORD },
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

afterAll(async () => {
  await harness?.close();
  await disconnectTestDb();
});

type Method = 'GET' | 'POST';

const as = (session: () => Session, method: Method, url: string, body?: unknown) =>
  harness.app.inject({
    method,
    url,
    headers: session().headers(),
    ...(body !== undefined && { payload: body }),
  });

const asAdmin = (method: Method, url: string, body?: unknown) => as(() => admin, method, url, body);
const asManager = (method: Method, url: string, body?: unknown) =>
  as(() => manager, method, url, body);
const asViewer = (method: Method, url: string, body?: unknown) =>
  as(() => viewer, method, url, body);

interface CreatedStrategy {
  id: string;
  versions: { id: string; version: number; stage: string; frozen: boolean }[];
}

async function createStrategy(overrides: Record<string, unknown> = {}) {
  const response = await asManager('POST', '/api/strategies', {
    name: 'RSI bounce',
    definition: definition(),
    riskSettings,
    changeDescription: 'initial version over http',
    ...overrides,
  });
  expect(response.statusCode).toBe(201);
  return response.json() as CreatedStrategy;
}

/** Walks a version to LIVE over HTTP, one legal step at a time. */
async function takeLive(versionId: string): Promise<void> {
  for (const stage of [
    StrategyStage.BACKTEST,
    StrategyStage.PAPER,
    StrategyStage.REVIEW,
    StrategyStage.APPROVED,
    StrategyStage.LIVE,
  ]) {
    const response = await asAdmin('POST', `/api/strategies/versions/${versionId}/promote`, {
      stage,
    });
    expect(response.statusCode, `promoting to ${stage}`).toBe(200);
  }
}

describe('permissions', () => {
  it('hides strategies from a VIEWER entirely', async () => {
    // A viewer sees positions and performance, not the rules behind them.
    expect((await asViewer('GET', '/api/strategies')).statusCode).toBe(403);
  });

  it('lets a MANAGER author but not promote', async () => {
    const strategy = await createStrategy();
    const versionId = strategy.versions[0]!.id;

    const promote = await asManager('POST', `/api/strategies/versions/${versionId}/promote`, {
      stage: StrategyStage.BACKTEST,
    });
    // Writing a rule and letting it run are deliberately different rights.
    expect(promote.statusCode).toBe(403);
  });

  it('rejects an anonymous caller', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/api/strategies' });
    expect(response.statusCode).toBe(401);
  });
});

describe('authoring', () => {
  it('creates version 1 at DRAFT, already frozen', async () => {
    const strategy = await createStrategy();
    const version = strategy.versions[0]!;

    expect(version).toMatchObject({ version: 1, stage: StrategyStage.DRAFT, frozen: true });
  });

  it('refuses a change description that says nothing', async () => {
    const response = await asManager('POST', '/api/strategies', {
      name: 'Terse',
      definition: definition(),
      riskSettings,
      changeDescription: 'update',
    });
    expect(response.statusCode).toBe(422);
  });

  it('refuses a rule whose threshold is not a number', async () => {
    const response = await asManager('POST', '/api/strategies', {
      name: 'Nonsense threshold',
      definition: definition({
        entry: {
          direction: 'LONG',
          when: {
            type: 'condition',
            field: 'rsi14',
            operator: 'lt',
            operand: { constant: 'soon' },
          },
        },
      }),
      riskSettings,
      changeDescription: 'a threshold that is not a number',
    });
    expect(response.statusCode).toBe(422);
  });

  it('refuses a second strategy with the same name', async () => {
    await createStrategy();
    const again = await asManager('POST', '/api/strategies', {
      name: 'RSI bounce',
      definition: definition(),
      riskSettings,
      changeDescription: 'duplicate name attempt',
    });
    expect(again.statusCode).toBe(409);
  });

  it('adds a version rather than editing one, and the new version starts at DRAFT', async () => {
    const strategy = await createStrategy();
    await takeLive(strategy.versions[0]!.id);

    const added = await asManager('POST', `/api/strategies/${strategy.id}/versions`, {
      definition: definition({ entry: { direction: 'LONG', when: rsiBelow(25) } }),
      riskSettings,
      changeDescription: 'tighten the entry threshold',
    });
    expect(added.statusCode).toBe(201);
    expect(added.json()).toMatchObject({ version: 2, stage: StrategyStage.DRAFT });

    // Version 1 is untouched and still the one running.
    const reread = await asAdmin('GET', `/api/strategies/${strategy.id}`);
    const body = reread.json() as { liveVersion: { version: number }; versions: unknown[] };
    expect(body.liveVersion.version).toBe(1);
    expect(body.versions).toHaveLength(2);
  });

  it('has no route that edits a definition in place', () => {
    // Immutability is structural: there is nothing to call. A draft is frozen
    // too, so no "edit the draft" endpoint can exist to be widened later.
    for (const url of [
      '/api/strategies/:id',
      '/api/strategies/:id/definition',
      '/api/strategies/versions/:id',
    ]) {
      for (const method of ['PATCH', 'PUT', 'DELETE'] as const) {
        expect(harness.app.hasRoute({ method, url }), `${method} ${url}`).toBe(false);
      }
    }
  });
});

describe('promotion', () => {
  it('refuses to skip a rung', async () => {
    const strategy = await createStrategy();
    const response = await asAdmin(
      `POST`,
      `/api/strategies/versions/${strategy.versions[0]!.id}/promote`,
      { stage: StrategyStage.LIVE },
    );
    expect(response.statusCode).toBe(409);
    expect(response.json().error.message).toContain('BACKTEST');
  });

  it('refuses to approve a version with no stop loss', async () => {
    const strategy = await createStrategy({
      name: 'No stop',
      definition: definition({ stop: null }),
    });
    const versionId = strategy.versions[0]!.id;

    for (const stage of [StrategyStage.BACKTEST, StrategyStage.PAPER, StrategyStage.REVIEW]) {
      expect(
        (await asAdmin('POST', `/api/strategies/versions/${versionId}/promote`, { stage }))
          .statusCode,
      ).toBe(200);
    }

    const approve = await asAdmin('POST', `/api/strategies/versions/${versionId}/promote`, {
      stage: StrategyStage.APPROVED,
    });
    expect(approve.statusCode).toBe(422);
    expect(approve.json().error.message).toContain('stop');
  });

  it('records who approved it, and approving does not make it live', async () => {
    const strategy = await createStrategy();
    const versionId = strategy.versions[0]!.id;

    for (const stage of [
      StrategyStage.BACKTEST,
      StrategyStage.PAPER,
      StrategyStage.REVIEW,
      StrategyStage.APPROVED,
    ]) {
      await asAdmin('POST', `/api/strategies/versions/${versionId}/promote`, { stage });
    }

    const reread = await asAdmin('GET', `/api/strategies/${strategy.id}`);
    const body = reread.json() as {
      liveVersion: unknown;
      versions: { approvedById: string | null; approvedAt: string | null }[];
    };
    expect(body.versions[0]!.approvedById).toEqual(expect.any(String));
    expect(body.versions[0]!.approvedAt).toEqual(expect.any(String));
    // Approved is not running. Going live is its own decision.
    expect(body.liveVersion).toBeNull();
  });

  it('refuses a second live version of the same strategy', async () => {
    const strategy = await createStrategy();
    await takeLive(strategy.versions[0]!.id);

    const second = await asManager('POST', `/api/strategies/${strategy.id}/versions`, {
      definition: definition(),
      riskSettings,
      changeDescription: 'a rival version of the same rules',
    });
    const secondId = (second.json() as { id: string }).id;

    for (const stage of [
      StrategyStage.BACKTEST,
      StrategyStage.PAPER,
      StrategyStage.REVIEW,
      StrategyStage.APPROVED,
    ]) {
      await asAdmin('POST', `/api/strategies/versions/${secondId}/promote`, { stage });
    }

    const live = await asAdmin('POST', `/api/strategies/versions/${secondId}/promote`, {
      stage: StrategyStage.LIVE,
    });
    expect(live.statusCode).toBe(409);
    expect(live.json().error.message).toContain('already live');
  });
});

describe('archiving', () => {
  it('refuses to archive a strategy that is still running', async () => {
    const strategy = await createStrategy();
    await takeLive(strategy.versions[0]!.id);

    const response = await asManager('POST', `/api/strategies/${strategy.id}/archive`, {
      archived: true,
    });
    expect(response.statusCode).toBe(409);
  });

  it('archives an idle strategy and refuses new versions afterwards', async () => {
    const strategy = await createStrategy();
    expect(
      (await asManager('POST', `/api/strategies/${strategy.id}/archive`, { archived: true }))
        .statusCode,
    ).toBe(200);

    const added = await asManager('POST', `/api/strategies/${strategy.id}/versions`, {
      definition: definition(),
      riskSettings,
      changeDescription: 'changing an archived strategy',
    });
    expect(added.statusCode).toBe(409);
  });
});

describe('evaluation', () => {
  it('refuses to evaluate a draft unless it is a dry run', async () => {
    const strategy = await createStrategy();
    const versionId = strategy.versions[0]!.id;

    const live = await asAdmin('POST', `/api/strategies/versions/${versionId}/evaluate`, {
      portfolioId,
      at: EVALUATE_AT,
    });
    expect(live.statusCode).toBe(409);

    const dry = await asAdmin('POST', `/api/strategies/versions/${versionId}/evaluate`, {
      portfolioId,
      dryRun: true,
      at: EVALUATE_AT,
    });
    expect(dry.statusCode).toBe(200);
  });

  it('records a signal at CREATED and nothing further', async () => {
    const strategy = await createStrategy();
    const versionId = strategy.versions[0]!.id;
    await takeLive(versionId);

    const run = await asAdmin('POST', `/api/strategies/versions/${versionId}/evaluate`, {
      portfolioId,
      at: EVALUATE_AT,
    });
    expect(run.statusCode).toBe(200);
    const result = run.json() as { created: { symbol: string }[]; correlationId: string };
    expect(result.created.map((s) => s.symbol)).toEqual(['AAPL']);

    const listed = await asAdmin('GET', `/api/strategies/signals?portfolioId=${portfolioId}`);
    expect(listed.statusCode).toBe(200);
    const { signals } = listed.json() as {
      signals: { status: string; referencePrice: string; strategyName: string }[];
    };
    expect(signals).toHaveLength(1);
    // A recommendation, and only a recommendation.
    expect(signals[0]!.status).toBe('CREATED');
    expect(signals[0]!.strategyName).toBe('RSI bounce');
    // Money crosses the wire as a string, so no float ever rounds it.
    expect(typeof signals[0]!.referencePrice).toBe('string');

    // No order or position came into existence.
    expect(await db.order.count()).toBe(0);
    expect(await db.position.count()).toBe(0);
  });

  it('is idempotent for the same bar — a replay creates no second signal', async () => {
    const strategy = await createStrategy();
    const versionId = strategy.versions[0]!.id;
    await takeLive(versionId);

    const body = { portfolioId, at: EVALUATE_AT };
    await asAdmin('POST', `/api/strategies/versions/${versionId}/evaluate`, body);
    const again = await asAdmin('POST', `/api/strategies/versions/${versionId}/evaluate`, body);

    expect(again.json()).toMatchObject({ created: [], duplicates: ['AAPL'] });
    expect(await db.signal.count()).toBe(1);
  });

  it('reports symbols it could not judge instead of dropping them', async () => {
    await db.instrument.create({ data: { symbol: 'MSFT', name: 'Microsoft', exchange: 'XNYS' } });
    const strategy = await createStrategy();
    const versionId = strategy.versions[0]!.id;
    await takeLive(versionId);

    const run = await asAdmin('POST', `/api/strategies/versions/${versionId}/evaluate`, {
      portfolioId,
      at: EVALUATE_AT,
    });
    const result = run.json() as { notEvaluable: { symbol: string; reason: string }[] };
    // MSFT has no bars. Silence would read as "no signal", which is a lie.
    expect(result.notEvaluable.map((s) => s.symbol)).toContain('MSFT');
    expect(result.notEvaluable[0]!.reason).toBeTruthy();
  });

  it('refuses a portfolio the caller cannot see', async () => {
    const strategy = await createStrategy();
    const versionId = strategy.versions[0]!.id;

    const response = await as(
      () => manager,
      'POST',
      `/api/strategies/versions/${versionId}/evaluate`,
      { portfolioId, dryRun: true, at: EVALUATE_AT },
    );
    // A MANAGER has signal:read but no grant on this portfolio.
    expect([403, 404]).toContain(response.statusCode);
  });

  it('404s on an unknown version', async () => {
    const response = await asAdmin(
      'POST',
      '/api/strategies/versions/00000000-0000-4000-8000-000000000000/evaluate',
      { portfolioId, dryRun: true },
    );
    expect(response.statusCode).toBe(404);
  });
});

describe('a version this build cannot read', () => {
  /**
   * Versions are immutable and kept forever, so a definition written by an
   * older build whose rule language has since changed will exist one day. The
   * platform has to stay usable around it.
   */
  async function seedUnreadableVersion(): Promise<string> {
    const strategy = await db.strategy.create({ data: { name: 'Legacy rules' } });
    await db.strategyVersion.create({
      data: {
        strategyId: strategy.id,
        version: 1,
        stage: 'DRAFT',
        changeDescription: 'written by a build that spoke a different rule language',
        definition: { type: 'AND', conditions: [{ indicator: 'ADX', operator: 'GT', value: 20 }] },
        riskSettings: { stopLossPct: 2, sizing: 'RISK_BASED' },
      },
    });
    return strategy.id;
  }

  it('lists it rather than failing the whole listing', async () => {
    await seedUnreadableVersion();
    await createStrategy();

    const response = await asAdmin('GET', '/api/strategies');
    expect(response.statusCode).toBe(200);
    const { strategies } = response.json() as { strategies: CreatedStrategy[] };
    // Both are present: one unreadable row must not hide every other strategy.
    expect(strategies).toHaveLength(2);
  });

  it('reports the definition as null instead of guessing at it', async () => {
    const strategyId = await seedUnreadableVersion();

    const response = await asAdmin('GET', `/api/strategies/${strategyId}`);
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      versions: { definition: unknown; entrySummary: string | null; fieldsUsed: string[] }[];
    };
    expect(body.versions[0]!.definition).toBeNull();
    expect(body.versions[0]!.entrySummary).toBeNull();
    expect(body.versions[0]!.fieldsUsed).toEqual([]);
  });

  it('refuses to promote or evaluate it', async () => {
    const strategyId = await seedUnreadableVersion();
    const versionId = (await db.strategyVersion.findFirstOrThrow({ where: { strategyId } })).id;

    const promote = await asAdmin('POST', `/api/strategies/versions/${versionId}/promote`, {
      stage: StrategyStage.BACKTEST,
    });
    expect(promote.statusCode).toBe(409);
    expect(promote.json().error.message).toContain('cannot read');

    const evaluate = await asAdmin('POST', `/api/strategies/versions/${versionId}/evaluate`, {
      portfolioId,
      dryRun: true,
      at: EVALUATE_AT,
    });
    expect(evaluate.statusCode).toBe(409);
  });
});
