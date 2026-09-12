import { SignalStatus, UserRole, dec } from '@zusu/shared';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AnalysisService } from '../../src/modules/ai/analysis.service.js';
import { BudgetGovernor } from '../../src/modules/ai/budget.js';
import { UnconfiguredProvider } from '../../src/modules/ai/anthropic-provider.js';
import {
  AnalysisError,
  type AnalysisProvider,
  type CompletionResponse,
} from '../../src/modules/ai/types.js';
import { IndicatorService } from '../../src/modules/market-data/indicator.service.js';
import { MarketDataQualityService } from '../../src/modules/market-data/quality.service.js';
import type { ProviderCandle } from '../../src/modules/market-data/types.js';
import { disconnectTestDb, resetDatabase, testDb } from '../helpers/db.js';
import { createPortfolio, createUser } from '../helpers/fixtures.js';

/**
 * The analysis engine, against a fake provider.
 *
 * This deployment has no `ANTHROPIC_API_KEY`, so no test here has spoken to
 * the real API. What they pin is the behaviour around a model rather than the
 * model: that a refusal is stored, that unparseable output produces no advice,
 * that spend is capped before a call rather than reported after it, and that
 * nothing a model says can move a signal towards an order.
 */

const db = testDb();
let portfolioId: string;
let signalId: string;

const BAR_MS = 300_000;
const START = Date.UTC(2026, 6, 15, 14, 0);

function bars(symbol: string, count: number): ProviderCandle[] {
  return Array.from({ length: count }, (_, i) => {
    const openTime = new Date(START + i * BAR_MS);
    const price = 100 + Math.sin(i / 4) * 3;
    return {
      symbol,
      timeframe: '5m' as const,
      openTime,
      closeTime: new Date(openTime.getTime() + BAR_MS),
      open: dec(price.toFixed(4)),
      high: dec((price + 0.4).toFixed(4)),
      low: dec((price - 0.4).toFixed(4)),
      close: dec(price.toFixed(4)),
      volume: dec(10_000),
      vwap: null,
      tradeCount: 20,
      isAdjusted: true,
    };
  });
}

/** A provider that replies with whatever the test hands it. */
function fakeProvider(
  reply: string | (() => never),
  usage = { inputTokens: 500, outputTokens: 120 },
): AnalysisProvider & { calls: number } {
  const provider = {
    name: 'fake',
    calls: 0,
    isConfigured: () => true,
    complete: (): Promise<CompletionResponse> => {
      provider.calls += 1;
      if (typeof reply !== 'string') reply();
      return Promise.resolve({
        text: reply,
        model: 'claude-sonnet-5',
        usage,
        latencyMs: 42,
        stopReason: 'end_turn',
      });
    },
  };
  return provider;
}

const goodAnalysis = JSON.stringify({
  action: 'CONSIDER',
  confidence: 0.55,
  riskLevel: 'MEDIUM',
  rationale: 'Oversold on the newest bar while price holds above its 50-period average.',
  invalidation: 'A close below the 50-period average.',
  missingContext: ['earnings date'],
  regime: 'RANGE_BOUND',
});

function serviceWith(
  provider: AnalysisProvider,
  limits?: { dailyUsd: string; callsPerHour: number; maxOutputTokensPerCall: number },
): AnalysisService {
  return new AnalysisService(
    db,
    provider,
    new IndicatorService(db),
    limits ? new BudgetGovernor(db, limits) : undefined,
  );
}

beforeEach(async () => {
  await resetDatabase();
  await createUser(db, { email: 'quant@test.local', role: UserRole.MANAGER });
  const portfolio = await createPortfolio(db, { name: 'Alpha' });
  portfolioId = portfolio.id;

  await db.instrument.create({ data: { symbol: 'AAPL', name: 'Apple', exchange: 'XNYS' } });
  await new MarketDataQualityService(db).ingestCandles(bars('AAPL', 80), {
    provider: 'test-feed',
  });

  const author = await db.user.findUniqueOrThrow({ where: { email: 'quant@test.local' } });
  const strategy = await db.strategy.create({
    data: {
      name: 'Test rule',
      versions: {
        create: {
          version: 1,
          stage: 'LIVE',
          changeDescription: 'seeded for the analysis tests',
          // A LIVE version must record who signed it — the database refuses
          // otherwise, which is Phase 3's constraint doing its job.
          approvedById: author.id,
          approvedAt: new Date(),
          definition: {
            timeframe: '5m',
            watchlistId: null,
            entry: {
              direction: 'LONG',
              when: {
                type: 'condition',
                field: 'rsi14',
                operator: 'lt',
                operand: { constant: '90' },
              },
            },
            exit: null,
            stop: { kind: 'PERCENT', value: '2' },
            target: { kind: 'RISK_MULTIPLE', value: '2' },
          },
          riskSettings: { maxConcurrentPositions: 3, maxNotionalPerTrade: '5000', minBars: 30 },
        },
      },
    },
    include: { versions: true },
  });

  const signal = await db.signal.create({
    data: {
      signalKey: `TEST_v1:AAPL:${portfolioId}:${new Date(START).toISOString().slice(0, 16)}Z`,
      correlationId: randomUUID(),
      portfolioId,
      strategyId: strategy.id,
      strategyVersionId: strategy.versions[0]!.id,
      symbol: 'AAPL',
      direction: 'LONG',
      status: SignalStatus.CREATED,
      referencePrice: '100',
      suggestedStop: '98',
      suggestedTarget: '104',
      conditionSnapshot: { satisfied: true, field: 'rsi14' },
    },
  });
  signalId = signal.id;
});

afterAll(async () => {
  await disconnectTestDb();
});

describe('a model cannot authorise anything', () => {
  it('leaves the signal exactly where it was, whatever the analysis says', async () => {
    const service = serviceWith(fakeProvider(goodAnalysis));

    const outcome = await service.analyseSignal({ signalId });

    expect(outcome.result?.action).toBe('CONSIDER');
    expect(outcome.result?.confidence).toBe(0.55);
    // High confidence and a CONSIDER, and the signal has not moved an inch.
    const signal = await db.signal.findUniqueOrThrow({ where: { id: signalId } });
    expect(signal.status).toBe(SignalStatus.CREATED);
    expect(signal.approvedById).toBeNull();
    expect(await db.order.count()).toBe(0);
  });

  it('has no method that approves, sizes or places anything', () => {
    const service = serviceWith(fakeProvider(goodAnalysis));

    // Structural rather than a promise: there is nothing to call.
    for (const method of ['approve', 'placeOrder', 'execute', 'size', 'trade']) {
      expect(method in service).toBe(false);
    }
  });

  it('drops any extra field a model volunteers', async () => {
    const service = serviceWith(
      fakeProvider(
        JSON.stringify({
          ...JSON.parse(goodAnalysis),
          quantity: 500,
          orderType: 'MARKET',
          execute: true,
        }),
      ),
    );

    const outcome = await service.analyseSignal({ signalId });

    expect(outcome.result).not.toBeNull();
    // The schema cannot express an instruction, so the instruction is gone.
    expect(JSON.stringify(outcome.result)).not.toContain('quantity');
    expect(JSON.stringify(outcome.result)).not.toContain('execute');
  });
});

describe('output validation', () => {
  it('stores an unparseable reply as a failure and produces no advice', async () => {
    const service = serviceWith(fakeProvider('I think you should buy it.'));

    const outcome = await service.analyseSignal({ signalId });

    expect(outcome.result).toBeNull();
    expect(outcome.refusal).toContain('no JSON object');

    const row = await db.aiAnalysis.findUniqueOrThrow({ where: { id: outcome.analysisId } });
    expect(row.responseValid).toBe(false);
    expect(row.action).toBeNull();
    // The raw text is kept, so the failure is diagnosable rather than lost.
    expect(JSON.stringify(row.responsePayload)).toContain('you should buy it');
  });

  it('rejects a reply whose confidence is out of range rather than clamping it', async () => {
    const service = serviceWith(
      fakeProvider(JSON.stringify({ ...JSON.parse(goodAnalysis), confidence: 3 })),
    );

    const outcome = await service.analyseSignal({ signalId });

    expect(outcome.result).toBeNull();
    expect(outcome.refusal).toContain('confidence');
  });

  it('still charges for a call whose output did not validate', async () => {
    const service = serviceWith(fakeProvider('not json'));

    const outcome = await service.analyseSignal({ signalId });
    const row = await db.aiAnalysis.findUniqueOrThrow({ where: { id: outcome.analysisId } });

    // The money was spent. A failed parse that recorded no cost would
    // understate the day's spend and let a loop run for free.
    expect(Number(row.costUsd?.toString())).toBeGreaterThan(0);
    expect(row.inputTokens).toBe(500);
  });

  it('treats INSUFFICIENT_CONTEXT as an answer, not a failure', async () => {
    const service = serviceWith(
      fakeProvider(
        JSON.stringify({
          action: 'INSUFFICIENT_CONTEXT',
          confidence: 0.1,
          riskLevel: 'HIGH',
          rationale: 'No volume profile or earnings date was provided.',
          invalidation: 'Nothing to invalidate without a view.',
          missingContext: ['volume profile', 'earnings date'],
          regime: null,
        }),
      ),
    );

    const outcome = await service.analyseSignal({ signalId });

    expect(outcome.result?.action).toBe('INSUFFICIENT_CONTEXT');
    const row = await db.aiAnalysis.findUniqueOrThrow({ where: { id: outcome.analysisId } });
    expect(row.responseValid).toBe(true);
  });
});

describe('spend control', () => {
  it('refuses a call that would cross the daily budget, and records the refusal', async () => {
    const provider = fakeProvider(goodAnalysis);
    const service = serviceWith(provider, {
      dailyUsd: '0.000001',
      callsPerHour: 100,
      maxOutputTokensPerCall: 2_000,
    });

    const outcome = await service.analyseSignal({ signalId });

    expect(outcome.result).toBeNull();
    expect(outcome.refusal).toContain('daily budget');
    // The provider was never called: the budget is checked before the money is
    // spent, not after.
    expect(provider.calls).toBe(0);

    const row = await db.aiAnalysis.findUniqueOrThrow({ where: { id: outcome.analysisId } });
    expect(row.responseValid).toBe(false);
    expect(row.costUsd).toBeNull();
  });

  it('refuses once the hourly call ceiling is reached', async () => {
    const provider = fakeProvider(goodAnalysis);
    const service = serviceWith(provider, {
      dailyUsd: '100',
      callsPerHour: 2,
      maxOutputTokensPerCall: 2_000,
    });

    await service.analyseSignal({ signalId });
    await service.analyseSignal({ signalId });
    const third = await service.analyseSignal({ signalId });

    // The limit that actually stops a runaway loop: a cheap model can make a
    // thousand calls well inside a modest dollar budget.
    expect(third.refusal).toContain('ceiling');
    expect(provider.calls).toBe(2);
  });

  it('counts refusals towards the hourly ceiling, so a loop cannot spin on them', async () => {
    const provider = fakeProvider(goodAnalysis);
    const service = serviceWith(provider, {
      dailyUsd: '0.000001',
      callsPerHour: 2,
      maxOutputTokensPerCall: 2_000,
    });

    await service.analyseSignal({ signalId });
    await service.analyseSignal({ signalId });
    const third = await service.analyseSignal({ signalId });

    expect(third.refusal).toContain('ceiling');
  });

  it('reports the spend it has actually recorded', async () => {
    const service = serviceWith(fakeProvider(goodAnalysis));

    await service.analyseSignal({ signalId });
    const spend = await service.spend();

    expect(Number(spend.spentTodayUsd)).toBeGreaterThan(0);
    expect(spend.callsLastHour).toBe(1);
    expect(spend.providerConfigured).toBe(true);
  });
});

describe('without a provider', () => {
  it('records that no call was made rather than inventing an answer', async () => {
    const service = serviceWith(new UnconfiguredProvider());

    const outcome = await service.analyseSignal({ signalId });

    expect(outcome.result).toBeNull();
    expect(outcome.refusal).toContain('ANTHROPIC_API_KEY is unset');

    const row = await db.aiAnalysis.findUniqueOrThrow({ where: { id: outcome.analysisId } });
    expect(row.responseValid).toBe(false);
    expect(row.costUsd).toBeNull();
  });

  it('reports itself unconfigured in the spend summary', async () => {
    const service = serviceWith(new UnconfiguredProvider());
    const spend = await service.spend();

    expect(spend.providerConfigured).toBe(false);
    expect(spend.providerName).toBe('unconfigured');
  });
});

describe('provider failures', () => {
  it('stores a retryable failure as a failure, and retries nothing on its own', async () => {
    const service = serviceWith(
      fakeProvider(() => {
        throw new AnalysisError('rate limited', true, 429);
      }),
    );

    const outcome = await service.analyseSignal({ signalId });

    expect(outcome.result).toBeNull();
    expect(outcome.refusal).toContain('retryable');
    // A silent retry would spend twice without anybody asking.
    expect(await db.aiAnalysis.count()).toBe(1);
  });
});

describe('the screen stage', () => {
  it('shortlists and sets aside, with a reason for each', async () => {
    const service = serviceWith(
      fakeProvider(
        JSON.stringify({
          shortlist: [{ symbol: 'AAPL', reason: 'oversold with trend intact' }],
          setAside: [{ symbol: 'MSFT', reason: 'no stored bars to judge' }],
        }),
      ),
    );

    const outcome = await service.screen({ symbols: ['AAPL', 'MSFT'], portfolioId });

    expect(outcome.result?.shortlist[0]?.symbol).toBe('AAPL');
    // Nothing vanishes silently: a symbol the screen dropped says why.
    expect(outcome.result?.setAside[0]?.reason).toContain('no stored bars');
  });

  it('uses the cheap model, so the expensive one only sees what survived', async () => {
    const service = serviceWith(fakeProvider(JSON.stringify({ shortlist: [], setAside: [] })));

    const outcome = await service.screen({ symbols: ['AAPL'] });
    const row = await db.aiAnalysis.findUniqueOrThrow({ where: { id: outcome.analysisId } });

    expect(row.purpose).toBe('SCREEN');
    expect(row.model).toContain('haiku');
  });

  it('tells the model when a symbol has no bars, rather than omitting it', async () => {
    const service = serviceWith(fakeProvider(JSON.stringify({ shortlist: [], setAside: [] })));

    const outcome = await service.screen({ symbols: ['AAPL', 'GHOST'] });
    const row = await db.aiAnalysis.findUniqueOrThrow({ where: { id: outcome.analysisId } });

    // A symbol the model was never shown must not look like one it declined.
    expect(JSON.stringify(row.requestPayload)).toContain('no stored bars for this symbol');
  });

  it('sends warm-up nulls as nulls', async () => {
    // Thirty bars cannot define a 50-period average, so `sma50` has no value.
    // A zero there would be an indicator the model reasons from as though it
    // were real.
    await db.instrument.create({ data: { symbol: 'NEW', name: 'Newly listed', exchange: 'XNYS' } });
    await new MarketDataQualityService(db).ingestCandles(bars('NEW', 30), {
      provider: 'test-feed',
    });

    const service = serviceWith(fakeProvider(JSON.stringify({ shortlist: [], setAside: [] })));

    const outcome = await service.screen({ symbols: ['NEW'] });
    const row = await db.aiAnalysis.findUniqueOrThrow({ where: { id: outcome.analysisId } });
    const payload = JSON.stringify(row.requestPayload);

    expect(payload).toContain('sma50');
    expect(payload).toContain('sma50\\":null');
  });

  it('refuses an empty symbol list', async () => {
    const service = serviceWith(fakeProvider(goodAnalysis));
    await expect(service.screen({ symbols: [] })).rejects.toThrow(/at least one symbol/);
  });
});

describe('regime detection', () => {
  it('stores a named regime with what produced it', async () => {
    const service = serviceWith(fakeProvider(goodAnalysis));

    await service.analyseSignal({ signalId });

    const regime = await db.marketRegime.findFirstOrThrow();
    expect(regime.regime).toBe('RANGE_BOUND');
    expect(regime.confidence.toString()).toBe('0.55');
    // The inputs are kept, so a classification is not an oracle.
    expect(JSON.stringify(regime.inputs)).toContain('analysis');
  });

  it('stores no regime when the model declines to name one', async () => {
    const service = serviceWith(
      fakeProvider(JSON.stringify({ ...JSON.parse(goodAnalysis), regime: null })),
    );

    await service.analyseSignal({ signalId });

    expect(await db.marketRegime.count()).toBe(0);
  });
});
