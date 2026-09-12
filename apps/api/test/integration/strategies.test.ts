import { StrategyStage, dec } from '@zusu/shared';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { RuleNode } from '../../src/modules/strategies/rule-tree.js';
import { signalKeyFor } from '../../src/modules/strategies/signal.service.js';
import { SignalService } from '../../src/modules/strategies/signal.service.js';
import { StrategyService } from '../../src/modules/strategies/strategy.service.js';
import type {
  RiskSettings,
  StrategyDefinition,
} from '../../src/modules/strategies/strategy.service.js';
import { MarketCalendarService } from '../../src/modules/market-data/calendar.service.js';
import { IndicatorService } from '../../src/modules/market-data/indicator.service.js';
import { MarketDataQualityService } from '../../src/modules/market-data/quality.service.js';
import { WatchlistService } from '../../src/modules/market-data/watchlist.service.js';
import type { ProviderCandle } from '../../src/modules/market-data/types.js';
import { disconnectTestDb, resetDatabase, testDb } from '../helpers/db.js';
import { createPortfolio, createUser } from '../helpers/fixtures.js';

const db = testDb();
let strategies: StrategyService;
let signals: SignalService;
let calendar: MarketCalendarService;
let quality: MarketDataQualityService;
let portfolioId: string;
let actorId: string;

/** A Wednesday inside a regular session, so the calendar permits trading. */
const SESSION_DAY = new Date('2026-07-15T00:00:00.000Z');
const BAR_START = Date.UTC(2026, 6, 15, 14, 0); // 10:00 New York
/**
 * The instant these evaluations claim to be for: one interval after the last
 * stored bar. Passed explicitly so the suite does not depend on the wall
 * clock — a run in 2027 must read exactly as a run today.
 */
const EVALUATE_AT = new Date(BAR_START + 60 * 300_000);

const rsiBelow = (value: number): RuleNode => ({
  type: 'condition',
  field: 'rsi14',
  operator: 'lt',
  operand: { constant: String(value) },
});

const rsiAbove = (value: number): RuleNode => ({
  type: 'condition',
  field: 'rsi14',
  operator: 'gt',
  operand: { constant: String(value) },
});

function definition(overrides: Partial<StrategyDefinition> = {}): StrategyDefinition {
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

const risk: RiskSettings = {
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
  strategies = new StrategyService(db);
  quality = new MarketDataQualityService(db);
  calendar = new MarketCalendarService(db);
  const indicators = new IndicatorService(db);
  const watchlists = new WatchlistService(db);
  signals = new SignalService(db, strategies, indicators, watchlists, calendar);

  const user = await createUser(db, { email: 'quant@test.local', role: 'ADMIN' });
  actorId = user.id;
  const portfolio = await createPortfolio(db, { name: 'Alpha' });
  portfolioId = portfolio.id;

  await calendar.sync('XNYS', SESSION_DAY, new Date('2026-07-16T00:00:00.000Z'));
  await db.instrument.create({ data: { symbol: 'AAPL', name: 'Apple', exchange: 'XNYS' } });
  await quality.ingestCandles(decliningBars('AAPL', 60), { provider: 'test-feed' });
});

afterAll(async () => {
  await disconnectTestDb();
});

const create = (overrides: Partial<Parameters<StrategyService['create']>[0]> = {}) =>
  strategies.create({
    name: 'RSI bounce',
    definition: definition(),
    riskSettings: risk,
    changeDescription: 'initial version for testing',
    authorId: actorId,
    ...overrides,
  });

/** Walks a version all the way to LIVE, one legal step at a time. */
async function takeLive(versionId: string): Promise<void> {
  for (const stage of [
    StrategyStage.BACKTEST,
    StrategyStage.PAPER,
    StrategyStage.REVIEW,
    StrategyStage.APPROVED,
    StrategyStage.LIVE,
  ]) {
    await strategies.promote(versionId, stage, { id: actorId });
  }
}

describe('creating a strategy', () => {
  it('creates version 1 at DRAFT', async () => {
    const strategy = await create();

    expect(strategy.versions).toHaveLength(1);
    expect(strategy.versions[0]).toMatchObject({ version: 1, stage: StrategyStage.DRAFT });
    expect(strategy.liveVersion).toBeNull();
  });

  it('renders the entry rule in words and lists the fields it needs', async () => {
    const strategy = await create();
    const version = strategy.versions[0];

    expect(version?.entrySummary).toBe('LONG when rsi14 below 90');
    // So a reader can tell how much history the strategy needs.
    expect(version?.fieldsUsed).toEqual(['rsi14']);
  });

  it('refuses a duplicate name', async () => {
    await create();
    await expect(create()).rejects.toThrow(/already exists/);
  });

  it('demands a change description that says something', async () => {
    await expect(create({ changeDescription: 'update' })).rejects.toThrow(/at least eight/);
  });

  it('surfaces an unreadable rule as such instead of half-evaluating it', async () => {
    await db.strategy.create({
      data: {
        name: 'Broken',
        versions: {
          create: {
            version: 1,
            changeDescription: 'stored by hand',
            definition: { nonsense: true },
            riskSettings: risk,
          },
        },
      },
    });

    // Versions are immutable and kept forever, so a definition written in an
    // older rule language will exist one day. It is reported as unreadable —
    // never guessed at, and never allowed to take the listing down with it.
    const listed = await strategies.list();
    const broken = listed.find((entry) => entry.name === 'Broken');
    expect(broken?.versions[0]?.definition).toBeNull();
    expect(broken?.versions[0]?.entrySummary).toBeNull();
    expect(broken?.versions[0]?.changeDescription).toBe('stored by hand');
  });
});

describe('versioning', () => {
  it('adds a version at DRAFT with its lineage recorded', async () => {
    const strategy = await create();
    const v2 = await strategies.addVersion(strategy.id, {
      definition: definition({ entry: { direction: 'LONG', when: rsiBelow(25) } }),
      riskSettings: risk,
      changeDescription: 'tighten the entry threshold',
      authorId: actorId,
    });

    expect(v2).toMatchObject({ version: 2, stage: StrategyStage.DRAFT });
    const row = await db.strategyVersion.findUniqueOrThrow({ where: { id: v2.id } });
    // "What were we running in August" needs an answer.
    expect(row.previousVersionId).toBe(strategy.versions[0]?.id);
  });

  it('cannot edit even a draft — every change is a new version', async () => {
    const strategy = await create();

    // Phase 1 freezes a definition the moment it is written. Stronger than
    // freezing only approved versions, and with no editable-draft special
    // case for a later change to widen.
    await expect(
      db.strategyVersion.update({
        where: { id: strategy.versions[0]!.id },
        data: { definition: { tampered: true } },
      }),
    ).rejects.toThrow(/immutable/);
  });
});

describe('the promotion ladder', () => {
  it('walks DRAFT to LIVE one step at a time', async () => {
    const strategy = await create();
    const id = strategy.versions[0]!.id;

    for (const stage of [
      StrategyStage.BACKTEST,
      StrategyStage.PAPER,
      StrategyStage.REVIEW,
      StrategyStage.APPROVED,
      StrategyStage.LIVE,
    ]) {
      const promoted = await strategies.promote(id, stage, { id: actorId });
      expect(promoted.stage).toBe(stage);
    }
  });

  it('refuses a skip, and says what is allowed instead', async () => {
    const strategy = await create();
    // The ladder exists so evidence accumulates before real money is involved.
    await expect(
      strategies.promote(strategy.versions[0]!.id, StrategyStage.LIVE, { id: actorId }),
    ).rejects.toThrow(/can only move to BACKTEST or RETIRED/);
  });

  it('refuses approval without a stop loss', async () => {
    const strategy = await create({ definition: definition({ stop: null }) });
    const id = strategy.versions[0]!.id;
    await strategies.promote(id, StrategyStage.BACKTEST, { id: actorId });
    await strategies.promote(id, StrategyStage.PAPER, { id: actorId });
    await strategies.promote(id, StrategyStage.REVIEW, { id: actorId });

    await expect(strategies.promote(id, StrategyStage.APPROVED, { id: actorId })).rejects.toThrow(
      /no stop loss/,
    );
  });

  it('records who approved it and when', async () => {
    const strategy = await create();
    const id = strategy.versions[0]!.id;
    await strategies.promote(id, StrategyStage.BACKTEST, { id: actorId });
    await strategies.promote(id, StrategyStage.PAPER, { id: actorId });
    await strategies.promote(id, StrategyStage.REVIEW, { id: actorId });
    const approved = await strategies.promote(id, StrategyStage.APPROVED, { id: actorId });

    // An approval nobody signed is not an approval.
    expect(approved.approvedById).toBe(actorId);
    expect(approved.approvedAt).not.toBeNull();
  });

  it('keeps APPROVED and LIVE separate, so approved never silently means running', async () => {
    const strategy = await create();
    const id = strategy.versions[0]!.id;
    await strategies.promote(id, StrategyStage.BACKTEST, { id: actorId });
    await strategies.promote(id, StrategyStage.PAPER, { id: actorId });
    await strategies.promote(id, StrategyStage.REVIEW, { id: actorId });
    await strategies.promote(id, StrategyStage.APPROVED, { id: actorId });

    expect((await strategies.get(strategy.id)).liveVersion).toBeNull();
  });

  it('allows only one live version per strategy', async () => {
    const strategy = await create();
    await takeLive(strategy.versions[0]!.id);

    const v2 = await strategies.addVersion(strategy.id, {
      definition: definition(),
      riskSettings: risk,
      changeDescription: 'a second candidate version',
    });
    for (const stage of [
      StrategyStage.BACKTEST,
      StrategyStage.PAPER,
      StrategyStage.REVIEW,
      StrategyStage.APPROVED,
    ]) {
      await strategies.promote(v2.id, stage, { id: actorId });
    }

    // Two live definitions make "which rules are running" unanswerable.
    await expect(strategies.promote(v2.id, StrategyStage.LIVE, { id: actorId })).rejects.toThrow(
      /already live/,
    );
  });

  it('allows retiring from any stage', async () => {
    const strategy = await create();
    const retired = await strategies.promote(strategy.versions[0]!.id, StrategyStage.RETIRED, {
      id: actorId,
    });
    expect(retired.stage).toBe(StrategyStage.RETIRED);
  });
});

describe('a live definition cannot change silently', () => {
  it('is enforced by the database, not only by the service', async () => {
    const strategy = await create();
    const id = strategy.versions[0]!.id;
    await takeLive(id);

    // Bypassing the service entirely must still fail: a bug or a console
    // session must not be able to rewrite a running strategy.
    await expect(
      db.strategyVersion.update({
        where: { id },
        data: { definition: { tampered: true } },
      }),
    ).rejects.toThrow(/frozen/);
  });

  it('permits a stage change on a frozen version, since that is not the definition', async () => {
    const strategy = await create();
    const id = strategy.versions[0]!.id;
    await takeLive(id);

    const retired = await strategies.promote(id, StrategyStage.RETIRED, { id: actorId });
    expect(retired.stage).toBe(StrategyStage.RETIRED);
  });
});

describe('the signal key', () => {
  it('is deterministic and readable', () => {
    const key = signalKeyFor({
      strategyName: 'RSI bounce',
      version: 3,
      symbol: 'AAPL',
      portfolioId: 'abc',
      barOpenTime: new Date('2026-09-09T14:30:00.000Z'),
    });
    // Readable on purpose: when a duplicate is refused, this is what a person
    // sees, and a digest would say nothing.
    expect(key).toBe('RSI_BOUNCE_v3:AAPL:abc:2026-09-09T14:30Z');
  });

  it('ignores seconds, so a replay of the same bar produces the same key', () => {
    const parts = {
      strategyName: 'X',
      version: 1,
      symbol: 'AAPL',
      portfolioId: 'p',
      barOpenTime: new Date('2026-09-09T14:30:00.000Z'),
    };
    const later = { ...parts, barOpenTime: new Date('2026-09-09T14:30:45.000Z') };
    expect(signalKeyFor(parts)).toBe(signalKeyFor(later));
  });

  it('differs by version, symbol, portfolio and bar', () => {
    const base = {
      strategyName: 'X',
      version: 1,
      symbol: 'AAPL',
      portfolioId: 'p',
      barOpenTime: new Date('2026-09-09T14:30:00.000Z'),
    };
    const keys = new Set([
      signalKeyFor(base),
      signalKeyFor({ ...base, version: 2 }),
      signalKeyFor({ ...base, symbol: 'MSFT' }),
      signalKeyFor({ ...base, portfolioId: 'q' }),
      signalKeyFor({ ...base, barOpenTime: new Date('2026-09-09T14:35:00.000Z') }),
    ]);
    expect(keys.size).toBe(5);
  });
});

describe('the signal engine', () => {
  async function liveStrategy(overrides: Partial<StrategyDefinition> = {}) {
    const strategy = await create({ definition: definition(overrides) });
    await takeLive(strategy.versions[0]!.id);
    return { strategy, versionId: strategy.versions[0]!.id };
  }

  it('creates a signal when the entry rule fires', async () => {
    const { versionId } = await liveStrategy();
    const result = await signals.evaluate({
      strategyVersionId: versionId,
      portfolioId,
      at: EVALUATE_AT,
    });

    expect(result.created).toHaveLength(1);
    expect(result.created[0]).toMatchObject({ symbol: 'AAPL', direction: 'LONG' });

    const signal = await db.signal.findFirstOrThrow();
    expect(signal.status).toBe('CREATED');
    expect(signal.referencePrice.toString()).toBe('170.5');
  });

  it('records the whole decision, so a signal can be audited afterwards', async () => {
    const { versionId } = await liveStrategy();
    await signals.evaluate({ strategyVersionId: versionId, portfolioId, at: EVALUATE_AT });

    const signal = await db.signal.findFirstOrThrow();
    const snapshot = signal.conditionSnapshot as Record<string, unknown>;
    expect(snapshot.entrySummary).toBe('LONG when rsi14 below 90');
    expect(snapshot.values).toHaveProperty('rsi14');
    expect(snapshot.trace).toBeTruthy();
    expect(snapshot.barOpenTime).toBeTruthy();
  });

  it('writes a lifecycle event naming the strategy that produced it', async () => {
    const { versionId } = await liveStrategy();
    await signals.evaluate({ strategyVersionId: versionId, portfolioId, at: EVALUATE_AT });

    const event = await db.signalEvent.findFirstOrThrow();
    expect(event.toStatus).toBe('CREATED');
    expect(event.fromStatus).toBeNull();
    expect(event.actor).toMatch(/RSI bounce v1/);
  });

  it('suggests a stop and a target derived from the reference price', async () => {
    const { versionId } = await liveStrategy();
    await signals.evaluate({ strategyVersionId: versionId, portfolioId, at: EVALUATE_AT });

    const signal = await db.signal.findFirstOrThrow();
    // 2% below 170.5, and a target two times that risk above it.
    expect(signal.suggestedStop?.toString()).toBe('167.09');
    expect(signal.suggestedTarget?.toString()).toBe('177.32');
  });

  it('never creates the same signal twice for one bar', async () => {
    const { versionId } = await liveStrategy();

    const first = await signals.evaluate({
      strategyVersionId: versionId,
      portfolioId,
      at: EVALUATE_AT,
    });
    const second = await signals.evaluate({
      strategyVersionId: versionId,
      portfolioId,
      at: EVALUATE_AT,
    });

    expect(first.created).toHaveLength(1);
    expect(second.created).toHaveLength(0);
    expect(second.duplicates).toEqual(['AAPL']);
    expect(await db.signal.count()).toBe(1);
  });

  it('deduplicates under concurrency, because the database decides', async () => {
    const { versionId } = await liveStrategy();

    // Two runs racing: a check-then-insert would let both through.
    const [a, b] = await Promise.all([
      signals.evaluate({ strategyVersionId: versionId, portfolioId, at: EVALUATE_AT }),
      signals.evaluate({ strategyVersionId: versionId, portfolioId, at: EVALUATE_AT }),
    ]);

    expect(a.created.length + b.created.length).toBe(1);
    expect(await db.signal.count()).toBe(1);
  });

  it('records a rejection rather than a signal when the rule says no', async () => {
    // The bars decline monotonically, so RSI is exactly 0 — "above 99" is
    // firmly false, where "below 1" would have fired.
    const { versionId } = await liveStrategy({
      entry: { direction: 'LONG', when: rsiAbove(99) },
    });
    const result = await signals.evaluate({
      strategyVersionId: versionId,
      portfolioId,
      at: EVALUATE_AT,
    });

    expect(result.created).toHaveLength(0);
    expect(result.rejected).toEqual(['AAPL']);
    expect(await db.signal.count()).toBe(0);
  });

  it('reports a symbol it could not judge, rather than dropping it', async () => {
    const { versionId } = await liveStrategy({
      entry: {
        direction: 'LONG',
        // 60 bars cannot define a 50-period average plus a 14-period RSI on
        // top; sma50 is available but this asks for something absent.
        when: { type: 'condition', field: 'sma50', operator: 'gt', operand: { constant: '0' } },
      },
    });
    await db.marketDataCandle.deleteMany({});
    await quality.ingestCandles(decliningBars('AAPL', 40), { provider: 'test-feed' });

    const result = await signals.evaluate({
      strategyVersionId: versionId,
      portfolioId,
      // Just after the shortened series, so the skip is about the missing
      // indicator rather than about the bar being old.
      at: new Date(BAR_START + 40 * 300_000),
    });
    expect(result.created).toHaveLength(0);
    expect(result.notEvaluable[0]?.symbol).toBe('AAPL');
    expect(result.notEvaluable[0]?.reason).toMatch(/no value|bars stored/);
  });

  it('refuses to evaluate a version that is not live', async () => {
    const strategy = await create();
    await expect(
      signals.evaluate({
        strategyVersionId: strategy.versions[0]!.id,
        portfolioId,
        at: EVALUATE_AT,
      }),
    ).rejects.toThrow(/not LIVE/);
  });

  it('allows a dry run of a draft without creating anything live', async () => {
    const strategy = await create();
    const result = await signals.evaluate({
      strategyVersionId: strategy.versions[0]!.id,
      portfolioId,
      allowNonLive: true,
      at: EVALUATE_AT,
    });
    expect(result.created).toHaveLength(1);
  });

  it('will not fire on a bar outside the version’s session scope', async () => {
    const { versionId } = await liveStrategy();
    // Overnight bars: the calendar says the market was closed, so a
    // REGULAR_ONLY version must not act on the newest one.
    await db.marketDataCandle.deleteMany({});
    const overnight = decliningBars('AAPL', 60).map((bar, i) => ({
      ...bar,
      openTime: new Date(Date.UTC(2026, 6, 15, 2, i * 5)),
      closeTime: new Date(Date.UTC(2026, 6, 15, 2, i * 5 + 5)),
    }));
    await quality.ingestCandles(overnight, { provider: 'test-feed' });

    const result = await signals.evaluate({
      strategyVersionId: versionId,
      portfolioId,
      // Just after the last overnight bar, so the skip is about the session
      // rather than about the bar being old.
      at: new Date(Date.UTC(2026, 6, 15, 7, 0)),
    });
    expect(result.created).toHaveLength(0);
    expect(result.notEvaluable[0]?.reason).toMatch(/scope|CLOSED/);
  });

  it('reports an empty universe rather than silently doing nothing', async () => {
    const watchlists = new WatchlistService(db);
    const empty = await watchlists.create({ name: 'Empty' });
    const { versionId } = await liveStrategy({ watchlistId: empty.id });

    const result = await signals.evaluate({
      strategyVersionId: versionId,
      portfolioId,
      at: EVALUATE_AT,
    });
    expect(result.notEvaluable[0]?.reason).toMatch(/universe is empty/);
  });
});

describe('staleness', () => {
  it('refuses to judge a bar that is no longer current', async () => {
    const strategy = await create();
    const versionId = strategy.versions[0]!.id;
    await takeLive(versionId);

    // Two days after the last stored bar: the market has not been open since,
    // so the newest candle answers a question about the past.
    const result = await signals.evaluate({
      strategyVersionId: versionId,
      portfolioId,
      at: new Date(BAR_START + 2 * 24 * 60 * 60 * 1000),
    });

    expect(result.created).toHaveLength(0);
    expect(result.notEvaluable[0]?.reason).toContain('too old to judge as current');
  });

  it('tolerates a bar a few intervals behind', async () => {
    const strategy = await create();
    const versionId = strategy.versions[0]!.id;
    await takeLive(versionId);

    // A late-arriving candle must not be mistaken for a stale market.
    const lastBar = BAR_START + 59 * 300_000;
    const result = await signals.evaluate({
      strategyVersionId: versionId,
      portfolioId,
      at: new Date(lastBar + 4 * 300_000),
    });

    expect(result.notEvaluable).toHaveLength(0);
    expect(result.created).toHaveLength(1);
  });
});
