import { randomUUID } from 'node:crypto';
import { ExecutionMode, StrategyStage, UserRole } from '@zusu/shared';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildContainer, type AppContainer } from '../../src/container.js';
import { AutomationService } from '../../src/modules/automation/automation.service.js';
import { LiveReadinessService } from '../../src/modules/automation/live-readiness.js';
import { BrokerRegistry } from '../../src/modules/broker/broker-registry.js';
import { MarketDataQualityService } from '../../src/modules/market-data/quality.service.js';
import type { ProviderCandle } from '../../src/modules/market-data/types.js';
import { OrderService } from '../../src/modules/orders/order.service.js';
import { RiskEngine } from '../../src/modules/risk/risk-engine.js';
import { TradingGate } from '../../src/modules/risk/trading-gate.js';
import { dec } from '@zusu/shared';
import type { Principal } from '../../src/modules/rbac/access-control.js';
import { confirmationPhraseFor } from '../../src/modules/automation/automation.service.js';
import { disconnectTestDb, resetDatabase, testDb } from '../helpers/db.js';
import { createPortfolio, createUser, grantPortfolioAccess } from '../helpers/fixtures.js';

/**
 * The automation ladder (Phase 9).
 *
 * The claim these tests defend is the platform's premise, restated for the one
 * place where a machine may act: **full automation is never reached
 * automatically.** Every rung is a person's act, one at a time, against
 * evidence — and the evidence is re-checked before every automatic order, not
 * only at the moment of promotion.
 */

const db = testDb();
let container: AppContainer;
let promoter: Principal;
let manager: Principal;
let portfolioId: string;
let strategyId: string;
let versionId: string;
let configId: string;

const NOW = new Date('2026-07-15T14:00:00Z');
const DAY = 86_400_000;

/** Everything the eight checks look for, present and passing. */
async function makeEverythingReady(): Promise<void> {
  // A portfolio may already carry conservative defaults; this makes the
  // limits explicit either way.
  await db.riskLimit.deleteMany({ where: { portfolioId } });
  await db.riskLimit.create({
    data: {
      portfolioId,
      version: 1,
      isActive: true,
      maxDailyLoss: '2000',
      maxWeeklyLoss: '5000',
      maxPositionSize: '10000',
      maxPortfolioExposurePct: '60',
      maxSectorExposurePct: '30',
      maxSymbolExposurePct: '15',
      maxOpenPositions: 10,
      maxTradesPerDay: 20,
      maxConsecutiveLosses: 4,
      maxDrawdownPct: '15',
    },
  });

  const backtest = await db.backtest.create({
    data: {
      strategyId,
      strategyVersionId: versionId,
      status: 'COMPLETED',
      timeframe: '5m',
      startDate: new Date(NOW.getTime() - 30 * DAY),
      endDate: NOW,
      initialCapital: '100000',
      parameters: {},
    },
  });
  await db.backtestTrade.createMany({
    data: Array.from({ length: 25 }, (_, i) => ({
      backtestId: backtest.id,
      symbol: 'AAPL',
      direction: 'LONG' as const,
      quantity: '10',
      entryTime: new Date(NOW.getTime() - (25 - i) * DAY),
      entryPrice: '100',
      exitPrice: '101',
      netPnl: '10',
    })),
  });

  await seedPaperRecord({ roundTrips: 12, spanDays: 10, profitable: true });
  await seedReconciliation({ succeeded: true, ageHours: 1 });
}

/** Paper evidence: filled orders for this strategy in a PAPER portfolio. */
async function seedPaperRecord(options: {
  roundTrips: number;
  spanDays: number;
  profitable: boolean;
}): Promise<void> {
  const paper = await createPortfolio(db, {
    name: `Paper ${randomUUID().slice(0, 8)}`,
    environment: 'PAPER',
  });
  const exitPrice = options.profitable ? '110' : '90';

  for (let i = 0; i < options.roundTrips; i += 1) {
    const at = new Date(NOW.getTime() - (options.spanDays - (i % options.spanDays)) * DAY);
    for (const side of ['BUY', 'SELL'] as const) {
      await db.order.create({
        data: {
          idempotencyKey: `paper:${randomUUID()}`,
          correlationId: randomUUID(),
          portfolioId: paper.id,
          strategyId,
          environment: 'PAPER',
          symbol: 'AAPL',
          side,
          orderType: 'MARKET',
          status: 'FILLED',
          requestedQty: '10',
          filledQty: '10',
          averageFillPrice: side === 'BUY' ? '100' : exitPrice,
          feesTotal: '0',
          createdAt: at,
          filledAt: at,
        },
      });
    }
  }
}

async function seedReconciliation(options: {
  succeeded: boolean;
  ageHours: number;
}): Promise<void> {
  const account = await db.brokerAccount.create({
    data: {
      portfolioId,
      environment: 'DEMO',
      broker: 'DEMO',
      label: 'Demo',
      connectionState: 'CONNECTED',
    },
  });
  await db.reconciliation.create({
    data: {
      brokerAccountId: account.id,
      startedAt: new Date(Date.now() - options.ageHours * 3_600_000),
      finishedAt: new Date(),
      succeeded: options.succeeded,
      detail: options.succeeded ? 'Cash, positions and orders agree.' : '3 differences found.',
    },
  });
}

function stateOf(
  report: { checks: { key: string; state: string }[] },
  key: string,
): string | undefined {
  return report.checks.find((check) => check.key === key)?.state;
}

beforeEach(async () => {
  await resetDatabase();
  container ??= buildContainer({ db });
  container.brokers.reset();

  const portfolio = await createPortfolio(db, { name: 'Automation', environment: 'DEMO' });
  portfolioId = portfolio.id;

  // Raising automation needs `strategy:promote`, which is administrator-only —
  // the same rule that stops an author promoting their own strategy.
  const admin = await createUser(db, { email: 'auto-admin@zusu.local', role: UserRole.ADMIN });
  await grantPortfolioAccess(db, admin.id, portfolioId, true);
  promoter = {
    id: admin.id,
    role: admin.role,
    clientId: admin.clientId,
    email: admin.email,
    isActive: admin.isActive,
  };

  const user = await createUser(db, { email: 'auto-manager@zusu.local', role: UserRole.MANAGER });
  await grantPortfolioAccess(db, user.id, portfolioId, true);
  manager = {
    id: user.id,
    role: user.role,
    clientId: user.clientId,
    email: user.email,
    isActive: user.isActive,
  };

  const strategy = await db.strategy.create({ data: { name: `Auto ${randomUUID().slice(0, 8)}` } });
  strategyId = strategy.id;
  const version = await db.strategyVersion.create({
    data: {
      strategyId,
      version: 1,
      stage: StrategyStage.LIVE,
      changeDescription: 'The first version of this strategy, for the automation tests.',
      approvedById: user.id,
      approvedAt: NOW,
      definition: {
        timeframe: '5m',
        watchlistId: null,
        entry: {
          direction: 'LONG',
          when: { type: 'condition', field: 'rsi14', operator: 'lt', operand: { constant: '30' } },
        },
        exit: null,
        stop: { kind: 'PERCENT', value: '2' },
        target: { kind: 'RISK_MULTIPLE', value: '2' },
      },
      riskSettings: { maxConcurrentPositions: 3, maxNotionalPerTrade: '10000', minBars: 30 },
    },
  });
  versionId = version.id;

  const config = await db.strategyPortfolioConfig.create({
    data: {
      strategyId,
      strategyVersionId: versionId,
      portfolioId,
      isEnabled: true,
      executionMode: ExecutionMode.MANUAL_APPROVAL,
      positionSizing: { method: 'FIXED_FRACTIONAL', riskPerTradePct: '1' },
    },
  });
  configId = config.id;
});

afterAll(async () => {
  await disconnectTestDb();
});

describe('live readiness', () => {
  it('passes all eight when every condition is genuinely met', async () => {
    await makeEverythingReady();
    const report = await container.readiness.report(configId);

    expect(report.checks).toHaveLength(8);
    expect(report.checks.filter((check) => check.state !== 'PASS')).toEqual([]);
    expect(report.ready).toBe(true);
    expect(report.nextMode).toBe(ExecutionMode.LIMITED_AUTO);
  });

  it('treats a stage label as a claim and the stored backtest as the evidence', async () => {
    await makeEverythingReady();
    await db.backtest.deleteMany({ where: { strategyVersionId: versionId } });

    const report = await container.readiness.report(configId);
    // The version is still stage LIVE. That is not evidence of anything.
    expect(stateOf(report, 'BACKTEST_COMPLETE')).toBe('FAIL');
    expect(report.ready).toBe(false);
  });

  it('refuses a backtest too small to measure the strategy rather than the sample', async () => {
    await makeEverythingReady();
    const backtest = await db.backtest.findFirstOrThrow({
      where: { strategyVersionId: versionId },
    });
    await db.backtestTrade.deleteMany({ where: { backtestId: backtest.id } });
    await db.backtestTrade.create({
      data: {
        backtestId: backtest.id,
        symbol: 'AAPL',
        direction: 'LONG',
        quantity: '10',
        entryTime: NOW,
        entryPrice: '100',
      },
    });

    const report = await container.readiness.report(configId);
    const check = report.checks.find((c) => c.key === 'BACKTEST_COMPLETE');
    expect(check?.state).toBe('FAIL');
    expect(check?.detail).toContain('1 trades against a required 20');
  });

  it('reports "never checked" as unverifiable, not as healthy', async () => {
    await makeEverythingReady();
    await db.reconciliation.deleteMany();

    const report = await container.readiness.report(configId);
    const check = report.checks.find((c) => c.key === 'RECONCILIATION_HEALTHY');
    // The distinction this gate most needs to keep: "we have never checked" is
    // not "we checked and it matched".
    expect(check?.state).toBe('UNVERIFIABLE');
    expect(report.ready).toBe(false);
  });

  it('treats stale agreement as unverifiable rather than current', async () => {
    await makeEverythingReady();
    await db.reconciliation.updateMany({
      data: { startedAt: new Date(Date.now() - 72 * 3_600_000) },
    });

    const report = await container.readiness.report(configId);
    expect(stateOf(report, 'RECONCILIATION_HEALTHY')).toBe('UNVERIFIABLE');
  });

  it('fails a paper test that did not make money', async () => {
    await makeEverythingReady();
    await db.order.deleteMany({ where: { environment: 'PAPER' } });
    await seedPaperRecord({ roundTrips: 12, spanDays: 10, profitable: false });

    const report = await container.readiness.report(configId);
    const check = report.checks.find((c) => c.key === 'PAPER_TEST_PASSED');
    expect(check?.state).toBe('FAIL');
    expect(check?.detail).toContain('not a reason to risk any');
  });

  it('fails a paper test that ran for a single day, however many trades', async () => {
    await makeEverythingReady();
    await db.order.deleteMany({ where: { environment: 'PAPER' } });
    await seedPaperRecord({ roundTrips: 30, spanDays: 1, profitable: true });

    const check = (await container.readiness.report(configId)).checks.find(
      (c) => c.key === 'PAPER_TEST_PASSED',
    );
    expect(check?.state).toBe('FAIL');
    expect(check?.detail).toContain('one regime, not a test');
  });

  it('blocks while the portfolio is halted', async () => {
    await makeEverythingReady();
    await db.portfolio.update({
      where: { id: portfolioId },
      data: { tradingState: 'HALTED', haltedReason: 'kill switch' },
    });

    const report = await container.readiness.report(configId);
    expect(stateOf(report, 'KILL_SWITCH_AVAILABLE')).toBe('FAIL');
    expect(report.ready).toBe(false);
  });

  it('blocks a version with no stop', async () => {
    await makeEverythingReady();
    const other = await db.strategyVersion.create({
      data: {
        strategyId,
        version: 2,
        stage: StrategyStage.DRAFT,
        changeDescription: 'A version deliberately written without a stop loss.',
        definition: {
          timeframe: '5m',
          watchlistId: null,
          entry: {
            direction: 'LONG',
            when: {
              type: 'condition',
              field: 'rsi14',
              operator: 'lt',
              operand: { constant: '30' },
            },
          },
          exit: null,
          stop: null,
          target: null,
        },
        riskSettings: { maxConcurrentPositions: 3, maxNotionalPerTrade: '10000', minBars: 30 },
      },
    });
    await db.strategyPortfolioConfig.update({
      where: { id: configId },
      data: { strategyVersionId: other.id },
    });

    const check = (await container.readiness.report(configId)).checks.find(
      (c) => c.key === 'STOP_LOSS_SET',
    );
    expect(check?.state).toBe('FAIL');
    expect(check?.detail).toContain('a bet, not a strategy');
  });

  it('every answer carries what it measured, never a bare verdict', async () => {
    await makeEverythingReady();
    const report = await container.readiness.report(configId);
    for (const check of report.checks) {
      expect(check.detail.length).toBeGreaterThan(12);
    }
  });
});

describe('the automation ladder', () => {
  it('refuses to skip a rung, whatever the readiness report says', async () => {
    await makeEverythingReady();
    await expect(
      container.automation.promote(promoter, configId, ExecutionMode.FULL_AUTO, {
        confirmation: confirmationPhraseFor(ExecutionMode.FULL_AUTO),
      }),
    ).rejects.toThrow(/one rung at a time/);
  });

  it('refuses a manager, because raising automation is administrator-only', async () => {
    await makeEverythingReady();
    await expect(
      container.automation.promote(manager, configId, ExecutionMode.LIMITED_AUTO, {
        confirmation: confirmationPhraseFor(ExecutionMode.LIMITED_AUTO),
      }),
    ).rejects.toThrow(/strategy:promote/);
  });

  it('refuses to raise without the exact confirmation phrase', async () => {
    await makeEverythingReady();
    await expect(
      container.automation.promote(promoter, configId, ExecutionMode.LIMITED_AUTO, {
        confirmation: 'yes',
      }),
    ).rejects.toThrow(/requires typing "I authorise LIMITED_AUTO" exactly/);
  });

  it('refuses to raise while any condition is unmet, and says which', async () => {
    await makeEverythingReady();
    await db.reconciliation.deleteMany();

    await expect(
      container.automation.promote(promoter, configId, ExecutionMode.LIMITED_AUTO, {
        confirmation: confirmationPhraseFor(ExecutionMode.LIMITED_AUTO),
      }),
    ).rejects.toThrow(/Reconciliation healthy/);
  });

  it('raises one rung when a person confirms against a clean report', async () => {
    await makeEverythingReady();
    const change = await container.automation.promote(
      promoter,
      configId,
      ExecutionMode.LIMITED_AUTO,
      { confirmation: confirmationPhraseFor(ExecutionMode.LIMITED_AUTO) },
    );

    expect(change.from).toBe(ExecutionMode.MANUAL_APPROVAL);
    expect(change.to).toBe(ExecutionMode.LIMITED_AUTO);

    // The authority is recorded, so the orders it places have a name on them.
    const config = await db.strategyPortfolioConfig.findUniqueOrThrow({ where: { id: configId } });
    expect((config.overrides as { promotedById?: string }).promotedById).toBe(promoter.id);
  });

  it('lowers from anywhere to anywhere below, with no confirmation and no checks', async () => {
    await makeEverythingReady();
    await container.automation.promote(promoter, configId, ExecutionMode.LIMITED_AUTO, {
      confirmation: confirmationPhraseFor(ExecutionMode.LIMITED_AUTO),
    });
    // Break readiness comprehensively. Lowering must still work: a brake a
    // state machine can decline to apply is not a brake.
    await db.reconciliation.deleteMany();
    await db.riskLimit.deleteMany();

    const change = await container.automation.promote(promoter, configId, ExecutionMode.OBSERVE);
    expect(change.to).toBe(ExecutionMode.OBSERVE);
    expect(change.detail).toContain('never refused');
  });

  it('clears the authority when lowered, so raising again is a fresh signature', async () => {
    await makeEverythingReady();
    await container.automation.promote(promoter, configId, ExecutionMode.LIMITED_AUTO, {
      confirmation: confirmationPhraseFor(ExecutionMode.LIMITED_AUTO),
    });
    await container.automation.promote(promoter, configId, ExecutionMode.MANUAL_APPROVAL);

    const config = await db.strategyPortfolioConfig.findUniqueOrThrow({ where: { id: configId } });
    expect((config.overrides as { promotedById?: string }).promotedById).toBeUndefined();
  });

  it('records a raise and a lowering as different audited actions', async () => {
    await makeEverythingReady();
    await container.automation.promote(promoter, configId, ExecutionMode.LIMITED_AUTO, {
      confirmation: confirmationPhraseFor(ExecutionMode.LIMITED_AUTO),
    });
    await container.automation.promote(promoter, configId, ExecutionMode.OBSERVE, {
      reason: 'watching something odd',
    });

    const actions = (
      await db.auditLog.findMany({
        where: { entityId: configId },
        orderBy: { seq: 'asc' },
        select: { action: true },
      })
    ).map((row) => row.action);
    expect(actions).toEqual(['STRATEGY_PROMOTED', 'STRATEGY_DEMOTED']);
  });
});

describe('automatic execution', () => {
  it('does nothing at all while nothing has been promoted', async () => {
    await makeEverythingReady();
    expect(await container.automation.runAutomatic(NOW)).toEqual([]);
  });

  it('defers every recommendation when a condition stops holding after promotion', async () => {
    await makeEverythingReady();
    await container.automation.promote(promoter, configId, ExecutionMode.LIMITED_AUTO, {
      confirmation: confirmationPhraseFor(ExecutionMode.LIMITED_AUTO),
    });
    await db.signal.create({
      data: {
        signalKey: `AUTO:${randomUUID()}`,
        correlationId: randomUUID(),
        portfolioId,
        strategyId,
        strategyVersionId: versionId,
        symbol: 'AAPL',
        direction: 'LONG',
        status: 'CREATED',
        referencePrice: '100',
        notional: '1000',
        conditionSnapshot: {},
      },
    });

    // Promotion was against a healthy report; the world then changed.
    await db.portfolio.update({
      where: { id: portfolioId },
      data: { tradingState: 'HALTED', haltedReason: 'kill switch' },
    });

    const runs = await container.automation.runAutomatic(NOW);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.placed).toEqual([]);
    expect(runs[0]?.deferred[0]?.reason).toContain('Automation is paused');
  });

  it('places nothing under nobody’s name', async () => {
    await makeEverythingReady();
    // A configuration forced onto an automatic rung without going through
    // promote — the shape a bad migration or a direct database edit leaves.
    await db.strategyPortfolioConfig.update({
      where: { id: configId },
      data: { executionMode: ExecutionMode.LIMITED_AUTO, overrides: {} },
    });
    await db.signal.create({
      data: {
        signalKey: `AUTO:${randomUUID()}`,
        correlationId: randomUUID(),
        portfolioId,
        strategyId,
        symbol: 'AAPL',
        direction: 'LONG',
        status: 'CREATED',
        referencePrice: '100',
        notional: '1000',
        conditionSnapshot: {},
      },
    });

    const runs = await container.automation.runAutomatic(NOW);
    expect(runs[0]?.placed).toEqual([]);
    expect(runs[0]?.deferred[0]?.reason).toContain('no recorded authority');
  });

  it('stops when the person who authorised it is deactivated', async () => {
    await makeEverythingReady();
    await container.automation.promote(promoter, configId, ExecutionMode.LIMITED_AUTO, {
      confirmation: confirmationPhraseFor(ExecutionMode.LIMITED_AUTO),
    });
    await db.signal.create({
      data: {
        signalKey: `AUTO:${randomUUID()}`,
        correlationId: randomUUID(),
        portfolioId,
        strategyId,
        symbol: 'AAPL',
        direction: 'LONG',
        status: 'CREATED',
        referencePrice: '100',
        notional: '1000',
        conditionSnapshot: {},
      },
    });
    await db.user.update({ where: { id: promoter.id }, data: { isActive: false } });

    const runs = await container.automation.runAutomatic(NOW);
    expect(runs[0]?.placed).toEqual([]);
    expect(runs[0]?.deferred[0]?.reason).toContain('no longer an active user');
  });

  it('defers a trade too big for the LIMITED_AUTO cap instead of shrinking it', async () => {
    await makeEverythingReady();
    await container.automation.promote(promoter, configId, ExecutionMode.LIMITED_AUTO, {
      confirmation: confirmationPhraseFor(ExecutionMode.LIMITED_AUTO),
    });
    await db.signal.create({
      data: {
        signalKey: `AUTO:${randomUUID()}`,
        correlationId: randomUUID(),
        portfolioId,
        strategyId,
        symbol: 'AAPL',
        direction: 'LONG',
        status: 'CREATED',
        referencePrice: '100',
        // Well past the 2500 default cap.
        notional: '50000',
        conditionSnapshot: {},
      },
    });

    const runs = await container.automation.runAutomatic(NOW);
    expect(runs[0]?.placed).toEqual([]);
    expect(runs[0]?.deferred[0]?.reason).toContain('exceeds the LIMITED_AUTO per-order cap');
    // The recommendation is untouched, still waiting for a person.
    const signal = await db.signal.findFirstOrThrow({ where: { portfolioId } });
    expect(signal.status).toBe('CREATED');
  });
});

/**
 * A gate that never opens is a feature that never works, so this is the
 * counterpart to every refusal above: the one path where an order really is
 * placed without anyone clicking Approve, under an authority someone granted.
 *
 * It needs its own venue clock. The simulated exchange refuses a closed market
 * — correctly — so the clock is placed inside the session these fixtures
 * describe rather than waiting for the real one to open.
 */
describe('an automatic order actually being placed', () => {
  const BAR_MS = 300_000;
  const SESSION_START = Date.UTC(2026, 6, 15, 14, 0);
  const AT = new Date(SESSION_START + 60 * BAR_MS);

  function bars(symbol: string, count: number, price = 100): ProviderCandle[] {
    return Array.from({ length: count }, (_, i) => {
      const openTime = new Date(SESSION_START + i * BAR_MS);
      return {
        symbol,
        timeframe: '5m' as const,
        openTime,
        closeTime: new Date(openTime.getTime() + BAR_MS),
        open: dec(price),
        high: dec(price + 0.5),
        low: dec(price - 0.5),
        close: dec(price),
        volume: dec(1_000_000),
        vwap: null,
        tradeCount: 100,
        isAdjusted: true,
      };
    });
  }

  it('places one order per waiting signal, in the authoriser’s name, capped', async () => {
    await makeEverythingReady();

    await db.instrument.create({
      data: { symbol: 'AAPL', name: 'Apple', exchange: 'XNYS', sector: 'Technology' },
    });
    await new MarketDataQualityService(db).ingestCandles(bars('AAPL', 80), {
      provider: 'test-feed',
    });
    await container.calendar.sync(
      'XNYS',
      new Date(Date.UTC(2026, 6, 15)),
      new Date(Date.UTC(2026, 6, 16)),
    );

    const venueClock = AT.getTime();
    const brokers = new BrokerRegistry({ db, now: () => venueClock });
    const orders = new OrderService(
      db,
      container.access,
      container.audit,
      brokers,
      new TradingGate(db, brokers, container.health, container.dataQuality, container.calendar),
      new RiskEngine(db),
    );
    const automation = new AutomationService(
      db,
      container.access,
      container.audit,
      new LiveReadinessService(db, brokers),
      orders,
    );

    await automation.promote(promoter, configId, ExecutionMode.LIMITED_AUTO, {
      confirmation: confirmationPhraseFor(ExecutionMode.LIMITED_AUTO),
    });

    await db.signal.create({
      data: {
        signalKey: `AUTO:${randomUUID()}`,
        correlationId: randomUUID(),
        portfolioId,
        strategyId,
        strategyVersionId: versionId,
        symbol: 'AAPL',
        direction: 'LONG',
        status: 'CREATED',
        referencePrice: '100',
        suggestedStop: '98',
        quantity: '10',
        notional: '1000',
        conditionSnapshot: {},
      },
    });

    const runs = await automation.runAutomatic(AT);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.deferred).toEqual([]);
    expect(runs[0]?.placed).toHaveLength(1);

    // The order exists, and it is attributed. An automated system acting under
    // nobody's authority is the thing this platform is built to not be.
    const order = await db.order.findFirstOrThrow({ where: { portfolioId } });
    expect(order.symbol).toBe('AAPL');
    const audit = await db.auditLog.findFirstOrThrow({
      where: { action: 'SIGNAL_APPROVED' },
    });
    expect(audit.actorUserId).toBe(promoter.id);
    // Recorded as the scheduler, so "did a person click this" stays answerable.
    expect(audit.actorType).toBe('SCHEDULER');
    expect(audit.actorLabel).toBe('automation');
  });
});
