import { UserRole, dec } from '@zusu/shared';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildContainer, type AppContainer } from '../../src/container.js';
import { MarketDataQualityService } from '../../src/modules/market-data/quality.service.js';
import type { ProviderCandle } from '../../src/modules/market-data/types.js';
import { disconnectTestDb, resetDatabase, testDb } from '../helpers/db.js';
import { createPortfolio, createUser } from '../helpers/fixtures.js';

/**
 * The portfolio risk engine.
 *
 * These are the limits the order manager spent three phases naming as not yet
 * enforced. The tests that matter are the ones where a number could have been
 * produced but should not be: an unclassified sector, a symbol with too little
 * history to correlate, a portfolio with no limits at all. Each blocks.
 */

const db = testDb();
let container: AppContainer;
let portfolioId: string;

const BAR_MS = 300_000;
const START = Date.UTC(2026, 6, 15, 13, 30);
const AT = new Date(START + 100 * BAR_MS);

/** Bars whose closes follow a path, so correlation is controllable. */
function bars(symbol: string, path: (i: number) => number, count = 60): ProviderCandle[] {
  return Array.from({ length: count }, (_, i) => {
    const close = path(i);
    const openTime = new Date(START + i * BAR_MS);
    return {
      symbol,
      timeframe: '5m' as const,
      openTime,
      closeTime: new Date(openTime.getTime() + BAR_MS),
      open: dec(close.toFixed(4)),
      high: dec((close + 0.5).toFixed(4)),
      low: dec((close - 0.5).toFixed(4)),
      close: dec(close.toFixed(4)),
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

  await createUser(db, { email: 'ops@test.local', role: UserRole.MANAGER });
  const portfolio = await createPortfolio(db, { name: 'Alpha', initialCapital: '100000' });
  portfolioId = portfolio.id;

  await db.instrument.create({
    data: { symbol: 'AAPL', name: 'Apple', exchange: 'XNYS', sector: 'Technology' },
  });
  await new MarketDataQualityService(db).ingestCandles(
    bars('AAPL', (i) => 100 + Math.sin(i / 3) * 2),
    { provider: 'test-feed' },
  );
});

afterAll(async () => {
  await disconnectTestDb();
});

const propose = (overrides: Record<string, unknown> = {}) =>
  container.risk.assess({
    portfolioId,
    symbol: 'AAPL',
    side: 'BUY',
    direction: 'LONG',
    entryPrice: dec('100'),
    stopPrice: dec('98'),
    at: AT,
    ...overrides,
  });

/**
 * Opens a position the way a fill would: shares in, cash out.
 *
 * Inserting a position without moving cash would leave a book whose equity
 * includes the stock *and* the money that bought it, and every exposure
 * percentage below would be measured against a number that cannot exist.
 */
async function openPosition(symbol: string, quantity: string, price: string): Promise<void> {
  await db.position.create({
    data: {
      portfolioId,
      symbol,
      status: 'OPEN',
      quantity,
      averageEntryPrice: price,
      openedAt: AT,
    },
  });
  const portfolio = await db.portfolio.findUniqueOrThrow({ where: { id: portfolioId } });
  await db.portfolio.update({
    where: { id: portfolioId },
    data: {
      cashBalance: dec(portfolio.cashBalance.toString())
        .minus(dec(quantity).times(dec(price)))
        .toString(),
    },
  });
}

/** The check by name, so a test asserts on the one it means. */
const checkNamed = (
  assessment: Awaited<ReturnType<AppContainer['risk']['assess']>>,
  name: string,
) => assessment.checks.find((check) => check.limitName === name);

describe('a check that cannot be evaluated blocks', () => {
  it('refuses a portfolio with no active risk limits', async () => {
    await db.riskLimit.updateMany({ where: { portfolioId }, data: { isActive: false } });

    const assessment = await propose();

    expect(assessment.allowed).toBe(false);
    expect(assessment.breaches[0]?.message).toContain('no active risk limits');
  });

  it('refuses a symbol with no sector recorded', async () => {
    await db.instrument.update({ where: { symbol: 'AAPL' }, data: { sector: null } });

    const assessment = await propose();
    const sector = checkNamed(assessment, 'sector exposure');

    // "We could not check" is not "it is fine".
    expect(sector?.passed).toBe(false);
    expect(sector?.actual).toBeNull();
    expect(sector?.message).toContain('Classify the instrument');
  });

  it('refuses a symbol with too little history to correlate', async () => {
    await db.instrument.create({
      data: { symbol: 'NEW', name: 'Newly listed', exchange: 'XNYS', sector: 'Technology' },
    });
    await openPosition('AAPL', '10', '100');

    const assessment = await propose({ symbol: 'NEW' });
    const correlation = checkNamed(assessment, 'correlation');

    expect(correlation?.passed).toBe(false);
    expect(correlation?.message).toContain('reason to wait');
  });
});

describe('sizing inside the assessment', () => {
  it('sizes from the stop and reports what bound it', async () => {
    const assessment = await propose({ riskPerTradePct: dec('1') });

    // 1% of ~100,000 equity over a 2-point stop, capped by the fixture's
    // 10,000 maximum position size: 100 shares.
    expect(assessment.sizing?.quantity.toString()).toBe('100');
    expect(assessment.sizing?.boundBy).toBe('MAX_NOTIONAL');
  });

  it('refuses to size without a stop, and says so as a failed check', async () => {
    const assessment = await propose({ stopPrice: null });

    expect(assessment.allowed).toBe(false);
    expect(assessment.breaches[0]?.message).toContain('no risk to size against');
  });
});

describe('exposure limits', () => {
  it('blocks a position over the maximum size', async () => {
    const assessment = await propose({ quantity: dec('500') });
    const check = checkNamed(assessment, 'max position size');

    expect(assessment.allowed).toBe(false);
    // The numbers are in the message, because a refusal without them cannot
    // be acted on.
    expect(check?.message).toContain('50000.00');
    expect(check?.message).toContain('10000.00');
  });

  it('counts existing positions towards portfolio exposure', async () => {
    await openPosition('AAPL', '600', '100');

    const assessment = await propose({ quantity: dec('10') });
    const exposure = checkNamed(assessment, 'portfolio exposure');

    // 60,000 of stock against the fixture's 60% limit, plus the new order.
    expect(exposure?.passed).toBe(false);
  });

  it('warns when a passing check is within a tenth of its limit', async () => {
    await openPosition('AAPL', '550', '100');

    const assessment = await propose({ quantity: dec('5') });

    // A pattern of near-misses is what makes the eventual breach unsurprising.
    const exposure = checkNamed(assessment, 'portfolio exposure');
    expect(exposure?.passed).toBe(true);
    expect(assessment.nearMisses.map((check) => check.limitName)).toContain('portfolio exposure');
  });
});

describe('loss limits', () => {
  it('counts a realised loss today against the daily limit', async () => {
    await db.position.create({
      data: {
        portfolioId,
        symbol: 'AAPL',
        status: 'CLOSED',
        quantity: '0',
        averageEntryPrice: '100',
        realizedPnl: '-2500',
        openedAt: AT,
        closedAt: AT,
      },
    });

    const assessment = await propose({ quantity: dec('1') });
    const daily = checkNamed(assessment, 'daily loss');

    // The fixture's limit is 2,000.
    expect(daily?.passed).toBe(false);
    expect(assessment.allowed).toBe(false);
  });

  it('does not let a profit create headroom for a bigger loss', async () => {
    await db.position.createMany({
      data: [
        {
          portfolioId,
          symbol: 'AAPL',
          status: 'CLOSED',
          quantity: '0',
          averageEntryPrice: '100',
          realizedPnl: '5000',
          openedAt: AT,
          closedAt: AT,
        },
      ],
    });

    const assessment = await propose({ quantity: dec('1') });
    const daily = checkNamed(assessment, 'daily loss');

    // Net is positive, so the loss is zero rather than negative headroom.
    expect(daily?.actual).toBe('0');
  });

  it('counts consecutive losses, stopping at the first winner', async () => {
    const base = {
      portfolioId,
      symbol: 'AAPL',
      status: 'CLOSED' as const,
      quantity: '0',
      averageEntryPrice: '100',
      openedAt: AT,
    };
    // Oldest first: a win, then five losses.
    for (const [index, pnl] of ['500', '-10', '-10', '-10', '-10', '-10'].entries()) {
      await db.position.create({
        data: { ...base, realizedPnl: pnl, closedAt: new Date(AT.getTime() + index * 1_000) },
      });
    }

    const assessment = await propose({ quantity: dec('1') });
    const streak = checkNamed(assessment, 'consecutive losses');

    // Five in a row against the fixture's limit of four.
    expect(streak?.actual).toBe('5');
    expect(streak?.passed).toBe(false);
  });
});

describe('correlation', () => {
  it('blocks a position that moves with something already held', async () => {
    await db.instrument.create({
      data: { symbol: 'TWIN', name: 'Twin', exchange: 'XNYS', sector: 'Technology' },
    });
    // An identical path, so the correlation is 1.
    await new MarketDataQualityService(db).ingestCandles(
      bars('TWIN', (i) => 100 + Math.sin(i / 3) * 2),
      { provider: 'test-feed' },
    );
    await openPosition('AAPL', '10', '100');

    const assessment = await propose({ symbol: 'TWIN', quantity: dec('1') });
    const correlation = checkNamed(assessment, 'correlation');

    expect(correlation?.passed).toBe(false);
    expect(correlation?.message).toContain('one position twice the size');
  });

  it('allows a position that moves differently', async () => {
    await db.instrument.create({
      data: { symbol: 'OTHER', name: 'Other', exchange: 'XNYS', sector: 'Technology' },
    });
    // A different period, so the two are far from identical.
    await new MarketDataQualityService(db).ingestCandles(
      bars('OTHER', (i) => 100 + Math.cos(i / 7) * 2),
      { provider: 'test-feed' },
    );
    await openPosition('AAPL', '10', '100');

    const assessment = await propose({ symbol: 'OTHER', quantity: dec('1') });
    const correlation = checkNamed(assessment, 'correlation');

    expect(correlation?.passed).toBe(true);
  });

  it('says there is nothing to correlate with on an empty book', async () => {
    const assessment = await propose({ quantity: dec('1') });
    const correlation = checkNamed(assessment, 'correlation');

    expect(correlation?.passed).toBe(true);
    expect(correlation?.message).toContain('nothing to be correlated with');
  });
});

describe('the drawdown breaker', () => {
  it('halts a portfolio past its drawdown limit, and records why', async () => {
    for (const [index, equity] of ['100000', '80000'].entries()) {
      await db.portfolioSnapshot.create({
        data: {
          portfolioId,
          asOf: new Date(AT.getTime() + index * 86_400_000),
          cashBalance: equity,
          positionsValue: '0',
          equity,
        },
      });
    }

    const results = await container.risk.runBreakers(AT);

    expect(results[0]?.halted).toBe(true);
    const portfolio = await db.portfolio.findUniqueOrThrow({ where: { id: portfolioId } });
    expect(portfolio.tradingState).toBe('HALTED');

    const event = await db.riskEvent.findFirstOrThrow({ where: { portfolioId } });
    expect(event.type).toBe('KILL_SWITCH_AUTOMATIC');
    expect(event.message).toContain('Only a person can release this');
  });

  it('never un-halts a portfolio, whatever the equity does next', async () => {
    await db.portfolio.update({ where: { id: portfolioId }, data: { tradingState: 'HALTED' } });
    for (const [index, equity] of ['100000', '150000'].entries()) {
      await db.portfolioSnapshot.create({
        data: {
          portfolioId,
          asOf: new Date(AT.getTime() + index * 86_400_000),
          cashBalance: equity,
          positionsValue: '0',
          equity,
        },
      });
    }

    await container.risk.runBreakers(AT);

    // A breaker that resets itself is one that trades through the thing it
    // was built to stop.
    const portfolio = await db.portfolio.findUniqueOrThrow({ where: { id: portfolioId } });
    expect(portfolio.tradingState).toBe('HALTED');
  });

  it('does nothing without two snapshots to measure a drawdown from', async () => {
    const results = await container.risk.runBreakers(AT);

    expect(results).toHaveLength(0);
    const portfolio = await db.portfolio.findUniqueOrThrow({ where: { id: portfolioId } });
    expect(portfolio.tradingState).toBe('ACTIVE');
  });
});

describe('recorded events', () => {
  it('stores breaches and near-misses with their numbers', async () => {
    const assessment = await propose({ quantity: dec('500') });
    await container.risk.recordEvents(portfolioId, assessment);

    const events = await container.risk.recentEvents(portfolioId);
    const breach = events.find((event) => event.limitName === 'max position size');

    expect(breach?.type).toBe('LIMIT_BREACH');
    expect(breach?.limitValue?.toString()).toBe('10000');
    expect(breach?.actualValue?.toString()).toBe('50000');
  });
});
