import { UserRole, dec } from '@zusu/shared';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildContainer, type AppContainer } from '../../src/container.js';
import { MarketDataQualityService } from '../../src/modules/market-data/quality.service.js';
import { Scheduler } from '../../src/modules/scheduler/scheduler.js';
import type { ProviderCandle } from '../../src/modules/market-data/types.js';
import { disconnectTestDb, resetDatabase, testDb } from '../helpers/db.js';
import { createPortfolio, createUser } from '../helpers/fixtures.js';

/**
 * The scheduler.
 *
 * The test that matters most is the last one: after every job has run, no
 * order exists. A scheduled job may stop trading and may never start any, and
 * that is the difference between this platform and an automated one.
 */

const db = testDb();
let container: AppContainer;
let scheduler: Scheduler;
let portfolioId: string;

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

const BAR_MS = 300_000;
const START = Date.UTC(2026, 6, 15, 13, 30);

function bars(symbol: string, count: number): ProviderCandle[] {
  return Array.from({ length: count }, (_, i) => {
    const openTime = new Date(START + i * BAR_MS);
    return {
      symbol,
      timeframe: '5m' as const,
      openTime,
      closeTime: new Date(openTime.getTime() + BAR_MS),
      open: dec(100),
      high: dec(101),
      low: dec(99),
      close: dec(100),
      volume: dec(10_000),
      vwap: null,
      tradeCount: 20,
      isAdjusted: true,
    };
  });
}

beforeEach(async () => {
  await resetDatabase();
  container ??= buildContainer({ db });
  scheduler = new Scheduler(container, logger);

  await createUser(db, { email: 'ops@test.local', role: UserRole.MANAGER });
  const portfolio = await createPortfolio(db, { name: 'Alpha', initialCapital: '100000' });
  portfolioId = portfolio.id;

  await db.instrument.create({ data: { symbol: 'AAPL', name: 'Apple', exchange: 'XNYS' } });
  await new MarketDataQualityService(db).ingestCandles(bars('AAPL', 80), {
    provider: 'test-feed',
  });
});

afterAll(async () => {
  scheduler.stop();
  await disconnectTestDb();
});

describe('what the jobs do', () => {
  it('syncs calendars ahead of time, so a read never has to', async () => {
    const state = await scheduler.runOnce('calendar-sync');

    expect(state.lastError).toBeNull();
    expect(state.lastOutcome).toContain('calendar days');
    expect(await db.marketCalendarDay.count()).toBeGreaterThan(0);
  });

  it('persists a health probe per service', async () => {
    const state = await scheduler.runOnce('health-persist');

    expect(state.lastError).toBeNull();
    expect(await db.systemHealthCheck.count()).toBeGreaterThan(0);
  });

  it('writes a snapshot per active portfolio', async () => {
    const state = await scheduler.runOnce('daily-snapshot');

    expect(state.lastOutcome).toContain('1 portfolio snapshots');
    expect(await db.portfolioSnapshot.count()).toBe(1);
  });

  it('evaluates live strategies into recommendations, not trades', async () => {
    const state = await scheduler.runOnce('strategy-evaluation');

    expect(state.lastError).toBeNull();
    // The wording is the point: whatever it produced is waiting for a person.
    expect(state.lastOutcome).toContain('awaiting a person');
    expect(await db.order.count()).toBe(0);
  });

  it('runs the drawdown breakers and reports what it found', async () => {
    const state = await scheduler.runOnce('risk-breakers');

    expect(state.lastError).toBeNull();
    expect(state.lastOutcome).toContain('drawdown limit');
  });

  it('halts a portfolio past its drawdown limit and says a person must release it', async () => {
    for (const [index, equity] of ['100000', '70000'].entries()) {
      await db.portfolioSnapshot.create({
        data: {
          portfolioId,
          asOf: new Date(START + index * 86_400_000),
          cashBalance: equity,
          positionsValue: '0',
          equity,
        },
      });
    }

    const state = await scheduler.runOnce('risk-breakers');

    expect(state.lastOutcome).toContain('release requires a person');
    const portfolio = await db.portfolio.findUniqueOrThrow({ where: { id: portfolioId } });
    expect(portfolio.tradingState).toBe('HALTED');
  });

  it('syncs open orders without creating any', async () => {
    const state = await scheduler.runOnce('order-sync');

    expect(state.lastOutcome).toContain('0 open orders');
    expect(await db.order.count()).toBe(0);
  });
});

describe('how it behaves when things go wrong', () => {
  it('records a failure and stays armed', async () => {
    const broken = new Scheduler(
      {
        ...container,
        performance: {
          writeSnapshot: () => Promise.reject(new Error('database is on fire')),
        } as unknown as AppContainer['performance'],
      },
      logger,
    );

    const failed = await broken.runOnce('daily-snapshot');
    expect(failed.failures).toBe(1);
    expect(failed.lastError).toContain('on fire');

    // Still runnable: a scheduler that dies on the first exception is one
    // nobody notices has died.
    const again = await broken.runOnce('daily-snapshot');
    expect(again.failures).toBe(2);
  });

  it('skips a tick rather than piling up behind itself', async () => {
    let release: (() => void) | undefined;
    let onStart: () => void = () => undefined;

    const gate = new Promise<void>((resolve) => {
      release = () => resolve();
    });
    // Resolved when the slow job has actually begun, so the test never races
    // the database call that precedes it.
    const begun = new Promise<void>((resolve) => {
      onStart = resolve;
    });

    const slow = new Scheduler(
      {
        ...container,
        performance: {
          writeSnapshot: () => {
            onStart();
            return gate;
          },
        } as unknown as AppContainer['performance'],
      },
      logger,
    );

    const first = slow.runOnce('daily-snapshot');
    await begun;

    const second = await slow.runOnce('daily-snapshot');
    expect(second.skips).toBe(1);

    release?.();
    const finished = await first;
    expect(finished.runs).toBe(1);
  });

  it('refuses a job it does not have', async () => {
    await expect(scheduler.runOnce('make-money')).rejects.toThrow(/No scheduler job/);
  });
});

describe('inspectability', () => {
  it('reports every job with its interval and last outcome', async () => {
    await scheduler.runOnce('daily-snapshot');
    const states = scheduler.jobStates();

    expect(states.map((state) => state.name)).toEqual(
      expect.arrayContaining([
        'calendar-sync',
        'health-persist',
        'order-sync',
        'strategy-evaluation',
        'daily-snapshot',
        'risk-breakers',
      ]),
    );

    const snapshotJob = states.find((state) => state.name === 'daily-snapshot');
    // "Is the snapshot writer working" has an answer that is not "read the
    // logs".
    expect(snapshotJob?.runs).toBe(1);
    expect(snapshotJob?.lastRunAt).toBeInstanceOf(Date);
    expect(snapshotJob?.lastDurationMs).toBeGreaterThanOrEqual(0);
  });
});

describe('the guarantee', () => {
  it('creates no order however many times every job runs', async () => {
    for (const name of [
      'calendar-sync',
      'health-persist',
      'order-sync',
      'strategy-evaluation',
      'daily-snapshot',
      'risk-breakers',
    ]) {
      await scheduler.runOnce(name);
      await scheduler.runOnce(name);
    }

    // The whole design in one assertion: no timer is a person.
    expect(await db.order.count()).toBe(0);
    expect(await db.execution.count()).toBe(0);
    expect(await db.position.count()).toBe(0);
  });

  it('has no job that approves a signal', () => {
    const names = scheduler.jobStates().map((state) => state.name);
    for (const forbidden of ['approve', 'auto-trade', 'execute', 'place-order']) {
      expect(names.some((name) => name.includes(forbidden))).toBe(false);
    }
  });
});
