import { randomUUID } from 'node:crypto';
import { OrderStatus, OrderType, SignalStatus, TimeInForce, UserRole, dec } from '@zusu/shared';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildContainer, type AppContainer } from '../../src/container.js';
import { BrokerRegistry } from '../../src/modules/broker/broker-registry.js';
import { OrderService } from '../../src/modules/orders/order.service.js';
import { RiskEngine } from '../../src/modules/risk/risk-engine.js';
import { TradingGate } from '../../src/modules/risk/trading-gate.js';
import { MarketDataQualityService } from '../../src/modules/market-data/quality.service.js';
import type { ProviderCandle } from '../../src/modules/market-data/types.js';
import type { Principal } from '../../src/modules/rbac/access-control.js';
import { disconnectTestDb, resetDatabase, testDb } from '../helpers/db.js';
import { buildTestApp, login } from '../helpers/app.js';
import { createPortfolio, createUser, grantPortfolioAccess } from '../helpers/fixtures.js';

/**
 * The order pipeline.
 *
 * The premise of the whole platform is under test here: a recommendation
 * becomes an order only by a person's act, and nothing automated can take that
 * step. Everything else is about surviving the act — one order per
 * idempotency key, one position per fill however many times it is polled, and
 * cash and shares that never disagree.
 */

const db = testDb();
let container: AppContainer;
/** Order service on a venue whose clock sits inside the seeded session. */
let orders: OrderService;
let brokers: BrokerRegistry;
/** The simulated venue's clock, advanced deliberately by `settled`. */
let venueClock = 0;
let portfolioId: string;
let trader: Principal;
let readOnly: Principal;
let calendarSynced = false;

const BAR_MS = 300_000;
/** A Wednesday inside a regular session, so the calendar permits trading. */
const START = Date.UTC(2026, 6, 15, 14, 0);
const NOW = new Date(START + 60 * BAR_MS);

function bars(symbol: string, count: number, price = 100): ProviderCandle[] {
  return Array.from({ length: count }, (_, i) => {
    const openTime = new Date(START + i * BAR_MS);
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

beforeEach(async () => {
  await resetDatabase();
  container ??= buildContainer({ db });
  container.brokers.reset();

  // The simulated venue will not fill a closed market — correctly — so its
  // clock is placed inside the session these fixtures describe. Waiting for
  // the real market to open is not a test.
  venueClock = NOW.getTime();
  brokers = new BrokerRegistry({ db, now: () => venueClock });
  orders = new OrderService(
    db,
    container.access,
    container.audit,
    brokers,
    new TradingGate(db, brokers, container.health, container.dataQuality, container.calendar),
    new RiskEngine(db),
  );

  const user = await createUser(db, { email: 'trader@test.local', role: UserRole.MANAGER });
  const viewer = await createUser(db, { email: 'reader@test.local', role: UserRole.MANAGER });
  trader = { ...user };
  readOnly = { ...viewer };

  const portfolio = await createPortfolio(db, { name: 'Alpha', initialCapital: '100000' });
  portfolioId = portfolio.id;
  await grantPortfolioAccess(db, user.id, portfolio.id, true);
  // Access without trading rights: reading a book and moving it are different.
  await grantPortfolioAccess(db, viewer.id, portfolio.id, false);

  // A sector, because the risk engine refuses to trade an instrument it
  // cannot check against the sector limit.
  await db.instrument.create({
    data: { symbol: 'AAPL', name: 'Apple', exchange: 'XNYS', sector: 'Technology' },
  });
  await new MarketDataQualityService(db).ingestCandles(bars('AAPL', 80), {
    provider: 'test-feed',
  });

  if (!calendarSynced) calendarSynced = true;
  await container.calendar.sync(
    'XNYS',
    new Date(Date.UTC(2026, 6, 15)),
    new Date(Date.UTC(2026, 6, 16)),
  );
});

afterAll(async () => {
  await disconnectTestDb();
});

/**
 * Advances the venue's clock past its matching latency, then applies what it
 * reports.
 *
 * An order does not fill the instant it is placed — the venue acknowledges
 * first and matches after a latency — so a test that asserted a position right
 * after `placeOrder` would be asserting a fiction.
 */
async function settled(orderId: string) {
  venueClock += 60_000;
  return orders.sync(orderId);
}

/** A live strategy version and one signal from it, ready to approve. */
async function seedSignal(overrides: { referencePrice?: string } = {}): Promise<string> {
  const strategy = await db.strategy.create({
    data: {
      name: 'Test rule',
      versions: {
        create: {
          version: 1,
          stage: 'LIVE',
          changeDescription: 'seeded for the order tests',
          approvedById: trader.id,
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
          riskSettings: {
            maxConcurrentPositions: 3,
            maxNotionalPerTrade: '10000',
            minBars: 30,
          },
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
      referencePrice: overrides.referencePrice ?? '100',
      suggestedStop: '98',
      suggestedTarget: '104',
      conditionSnapshot: {},
    },
  });
  return signal.id;
}

describe('who may turn a signal into an order', () => {
  it('refuses a caller without trading rights on the portfolio', async () => {
    const signalId = await seedSignal();

    await expect(
      orders.approveSignal(readOnly, signalId, { quantity: '10', at: NOW }),
    ).rejects.toThrow(/trading rights/);
    expect(await db.order.count()).toBe(0);
  });

  it('refuses a role without signal:approve', async () => {
    const client = await createUser(db, { email: 'client@test.local', role: UserRole.CLIENT });
    await grantPortfolioAccess(db, client.id, portfolioId, true);
    const signalId = await seedSignal();

    await expect(
      orders.approveSignal({ ...client }, signalId, { quantity: '10', at: NOW }),
    ).rejects.toThrow(/does not include/);
  });

  it('has no automated path: a signal left alone never becomes an order', async () => {
    await seedSignal();
    // Nothing polls, schedules or sweeps approvals. The recommendation sits
    // there, which is the whole design.
    expect(await db.order.count()).toBe(0);
    expect((await db.signal.findFirstOrThrow()).status).toBe(SignalStatus.CREATED);
  });
});

describe('approving a signal', () => {
  it('places one order and records who approved it', async () => {
    const signalId = await seedSignal();

    const order = await orders.approveSignal(trader, signalId, {
      quantity: '10',
      at: NOW,
    });

    expect(order.symbol).toBe('AAPL');
    expect(order.side).toBe('BUY');
    expect(order.requestedQty).toBe('10');
    expect(order.signalId).toBe(signalId);

    const audit = await db.auditLog.findFirst({ where: { action: 'SIGNAL_APPROVED' } });
    expect(audit?.actorUserId).toBe(trader.id);
  });

  it('walks the signal through its lifecycle, recording every step', async () => {
    const signalId = await seedSignal();
    await orders.approveSignal(trader, signalId, { quantity: '10', at: NOW });

    const events = await db.signalEvent.findMany({
      where: { signalId },
      orderBy: { createdAt: 'asc' },
    });
    const statuses = events.map((event) => event.toStatus);

    // RISK_CHECK before APPROVED, and APPROVED before the order was submitted:
    // the ladder is not skippable even when one action triggers all of it.
    expect(statuses).toContain(SignalStatus.RISK_CHECK);
    expect(statuses).toContain(SignalStatus.APPROVED);
    expect(statuses.indexOf(SignalStatus.RISK_CHECK)).toBeLessThan(
      statuses.indexOf(SignalStatus.APPROVED),
    );
    expect(events.every((event) => event.actor === trader.email)).toBe(true);
  });

  it('sizes from the version’s maximum notional when no quantity is given', async () => {
    const signalId = await seedSignal();
    const order = await orders.approveSignal(trader, signalId, { at: NOW });

    // 10,000 of notional at a reference price of 100 is 100 shares.
    expect(order.requestedQty).toBe('100');
  });

  it('refuses to approve the same signal twice', async () => {
    const signalId = await seedSignal();
    await orders.approveSignal(trader, signalId, { quantity: '10', at: NOW });

    await expect(
      orders.approveSignal(trader, signalId, { quantity: '10', at: NOW }),
    ).rejects.toThrow(/nothing to approve/);
  });

  it('records a rejection with its reason, and places no order', async () => {
    const signalId = await seedSignal();

    const rejected = await orders.rejectSignal(trader, signalId, 'the setup looks thin on volume');

    expect(rejected.status).toBe(SignalStatus.REJECTED);
    expect(await db.order.count()).toBe(0);
    const event = await db.signalEvent.findFirstOrThrow({ where: { signalId } });
    expect(event.reason).toContain('thin on volume');
  });

  it('will not accept a rejection with no reason', async () => {
    const signalId = await seedSignal();
    await expect(orders.rejectSignal(trader, signalId, 'no')).rejects.toThrow(/Say why/);
  });
});

describe('idempotency', () => {
  it('two approvals racing produce one order', async () => {
    const signalId = await seedSignal();

    const [first, second] = await Promise.allSettled([
      orders.approveSignal(trader, signalId, { quantity: '10', at: NOW }),
      orders.approveSignal(trader, signalId, { quantity: '10', at: NOW }),
    ]);

    // One wins; the other either finds the signal already moved on or is
    // handed the same order back. Either way there is exactly one.
    expect([first.status, second.status]).toContain('fulfilled');
    expect(await db.order.count()).toBe(1);

    const order = await db.order.findFirstOrThrow();
    await settled(order.id);
    expect(await db.position.count()).toBe(1);
  });

  it('a manual retry with the same key returns the same order', async () => {
    const key = 'deliberate-retry-key';
    const first = await orders.placeOrder(trader, {
      portfolioId,
      symbol: 'AAPL',
      side: 'BUY',
      quantity: '5',
      idempotencyKey: key,
      at: NOW,
    });
    const second = await orders.placeOrder(trader, {
      portfolioId,
      symbol: 'AAPL',
      side: 'BUY',
      quantity: '5',
      idempotencyKey: key,
      at: NOW,
    });

    expect(second.id).toBe(first.id);
    expect(await db.order.count()).toBe(1);
  });

  it('polling an order repeatedly never doubles the position', async () => {
    const order = await orders.placeOrder(trader, {
      portfolioId,
      symbol: 'AAPL',
      side: 'BUY',
      quantity: '10',
      at: NOW,
    });

    await settled(order.id);
    await orders.sync(order.id);
    await orders.sync(order.id);

    const position = await db.position.findFirstOrThrow({ where: { symbol: 'AAPL' } });
    expect(position.quantity.toString()).toBe('10');
    expect(await db.execution.count()).toBe(1);
  });
});

describe('fills, positions and lots', () => {
  it('does not fill the instant it is placed', async () => {
    const order = await orders.placeOrder(trader, {
      portfolioId,
      symbol: 'AAPL',
      side: 'BUY',
      quantity: '10',
      at: NOW,
    });

    // Acknowledged, not filled. A venue that filled synchronously would be
    // modelling a market nobody trades in.
    expect(order.filledQty).toBe('0');
    expect(await db.position.count()).toBe(0);
  });

  it('creates a position with a lot carrying its own cost basis', async () => {
    const order = await orders.placeOrder(trader, {
      portfolioId,
      symbol: 'AAPL',
      side: 'BUY',
      quantity: '10',
      at: NOW,
    });
    await settled(order.id);

    const position = await db.position.findFirstOrThrow({ include: { lots: true } });
    expect(position.status).toBe('OPEN');
    expect(position.quantity.toString()).toBe('10');
    expect(position.lots).toHaveLength(1);
    expect(Number(position.lots[0]!.costBasis.toString())).toBeGreaterThan(0);
  });

  it('keeps one lot per opening fill rather than averaging them away', async () => {
    const first = await orders.placeOrder(trader, {
      portfolioId,
      symbol: 'AAPL',
      side: 'BUY',
      quantity: '10',
      at: NOW,
    });
    await settled(first.id);
    const second = await orders.placeOrder(trader, {
      portfolioId,
      symbol: 'AAPL',
      side: 'BUY',
      quantity: '5',
      at: NOW,
    });
    await settled(second.id);

    const position = await db.position.findFirstOrThrow({ include: { lots: true } });
    expect(position.quantity.toString()).toBe('15');
    // Two lots: "what did we pay for these particular shares, and when" is a
    // question an average price cannot answer.
    expect(position.lots).toHaveLength(2);
  });

  it('closes lots oldest-first and realises the gain against their own basis', async () => {
    // On a PAPER portfolio, because the paper venue prices from the stored
    // bars: that is what lets this test buy at 100, buy again at 120, and
    // check which lot the sale consumed.
    const paper = await createPortfolio(db, {
      name: 'Paper',
      environment: 'PAPER',
      initialCapital: '100000',
    });
    await grantPortfolioAccess(db, trader.id, paper.id, true);

    await new MarketDataQualityService(db).ingestCandles(
      bars('AAPL', 6, 120).map((bar, i) => ({
        ...bar,
        openTime: new Date(START + (80 + i) * BAR_MS),
        closeTime: new Date(START + (81 + i) * BAR_MS),
      })),
      { provider: 'test-feed' },
    );

    venueClock = START + 40 * BAR_MS;
    const first = await orders.placeOrder(trader, {
      portfolioId: paper.id,
      symbol: 'AAPL',
      side: 'BUY',
      quantity: '10',
      at: new Date(venueClock),
    });
    venueClock = START + 42 * BAR_MS;
    await orders.sync(first.id);

    venueClock = START + 81 * BAR_MS;
    const second = await orders.placeOrder(trader, {
      portfolioId: paper.id,
      symbol: 'AAPL',
      side: 'BUY',
      quantity: '10',
      at: new Date(venueClock),
    });
    venueClock = START + 83 * BAR_MS;
    await orders.sync(second.id);

    const before = await db.position.findFirstOrThrow({
      where: { portfolioId: paper.id, status: 'OPEN' },
      include: { lots: { orderBy: { openedAt: 'asc' } } },
    });
    expect(before.lots).toHaveLength(2);
    // The lots kept their own prices rather than being averaged into one.
    expect(Number(before.lots[0]!.costBasis.toString())).toBeLessThan(1_100);
    expect(Number(before.lots[1]!.costBasis.toString())).toBeGreaterThan(1_100);

    const sell = await orders.placeOrder(trader, {
      portfolioId: paper.id,
      symbol: 'AAPL',
      side: 'SELL',
      quantity: '10',
      at: new Date(venueClock),
    });
    venueClock = START + 85 * BAR_MS;
    await orders.sync(sell.id);

    const position = await db.position.findFirstOrThrow({
      where: { portfolioId: paper.id, status: 'OPEN' },
      include: { lots: { orderBy: { openedAt: 'asc' } } },
    });
    expect(position.quantity.toString()).toBe('10');
    // The first lot, bought at 100 and sold near 120, is gone; the pricier
    // one remains. FIFO, not the cheapest or the most convenient.
    expect(position.lots[0]!.remainingQty.toString()).toBe('0');
    expect(position.lots[1]!.remainingQty.toString()).toBe('10');
    expect(Number(position.realizedPnl.toString())).toBeGreaterThan(150);
  });

  it('closes the position and keeps it as history when the last share goes', async () => {
    const buy = await orders.placeOrder(trader, {
      portfolioId,
      symbol: 'AAPL',
      side: 'BUY',
      quantity: '10',
      at: NOW,
    });
    await settled(buy.id);
    const sell = await orders.placeOrder(trader, {
      portfolioId,
      symbol: 'AAPL',
      side: 'SELL',
      quantity: '10',
      at: NOW,
    });
    await settled(sell.id);

    const closed = await db.position.findFirstOrThrow();
    expect(closed.status).toBe('CLOSED');
    expect(closed.closedAt).not.toBeNull();
    // Kept, not deleted: a closed position is the record of what happened.
    expect(await db.position.count()).toBe(1);
  });

  it('moves cash by the notional plus the fees, never a rounded guess', async () => {
    const before = await db.portfolio.findUniqueOrThrow({ where: { id: portfolioId } });

    const placed = await orders.placeOrder(trader, {
      portfolioId,
      symbol: 'AAPL',
      side: 'BUY',
      quantity: '10',
      at: NOW,
    });
    const order = await settled(placed.id);

    const after = await db.portfolio.findUniqueOrThrow({ where: { id: portfolioId } });
    const execution = await db.execution.findFirstOrThrow();
    const expected = dec(before.cashBalance.toString())
      .minus(dec(execution.price.toString()).times(dec(execution.quantity.toString())))
      .minus(dec(execution.fees.toString()));

    expect(after.cashBalance.toString()).toBe(expected.toString());
    expect(order.averageFillPrice).not.toBeNull();
  });

  it('measures slippage against the price the decision was based on', async () => {
    const signalId = await seedSignal({ referencePrice: '100' });
    const placed = await orders.approveSignal(trader, signalId, {
      quantity: '10',
      at: NOW,
    });
    const order = await settled(placed.id);

    // The demo venue crosses the spread, so a buy fills above the reference.
    expect(order.expectedPrice).toBe('100');
    expect(Number(order.slippage)).toBeGreaterThan(0);
  });

  it('writes a journal entry when a position opens, with the context that opened it', async () => {
    const signalId = await seedSignal();
    const placed = await orders.approveSignal(trader, signalId, {
      quantity: '10',
      at: NOW,
    });
    await settled(placed.id);

    const entry = await db.tradeJournalEntry.findFirstOrThrow();
    expect(entry.signalId).toBe(signalId);
    expect(entry.entryThesis).toContain('Approved signal');
    // Captured at entry, before the outcome is known — a thesis written after
    // the result is not a thesis.
    expect(entry.technicalContext).toMatchObject({ fillPrice: expect.any(String) });
  });
});

describe('pre-trade checks', () => {
  it('refuses an order larger than the maximum position size, and keeps the row', async () => {
    const order = await orders.placeOrder(trader, {
      portfolioId,
      symbol: 'AAPL',
      side: 'BUY',
      // The fixture's limit is 10,000; 500 shares near 100 is 50,000.
      quantity: '500',
      at: NOW,
    });

    expect(order.status).toBe(OrderStatus.REJECTED);
    expect(order.rejectionReason).toContain('maximum position size');
    // The refusal is a row, so "why did this not trade" has an answer.
    expect(await db.order.count()).toBe(1);
    expect(await db.position.count()).toBe(0);
  });

  it('refuses to trade a symbol it has no price for', async () => {
    await db.instrument.create({
      data: { symbol: 'MSFT', name: 'Microsoft', exchange: 'XNYS', sector: 'Technology' },
    });

    const order = await orders.placeOrder(trader, {
      portfolioId,
      symbol: 'MSFT',
      side: 'BUY',
      quantity: '1',
      at: NOW,
    });

    expect(order.status).toBe(OrderStatus.REJECTED);
    expect(order.rejectionReason).toContain('No stored price');
  });

  it('refuses when the portfolio has no active risk limits', async () => {
    await db.riskLimit.updateMany({ where: { portfolioId }, data: { isActive: false } });

    const order = await orders.placeOrder(trader, {
      portfolioId,
      symbol: 'AAPL',
      side: 'BUY',
      quantity: '1',
      at: NOW,
    });

    // No limits configured is not a green light.
    expect(order.status).toBe(OrderStatus.REJECTED);
    expect(order.rejectionReason).toContain('no active risk limits');
  });

  it('names every limit it checked, including the whole-book ones', async () => {
    const check = await orders.preTradeCheck(portfolioId, 'AAPL', dec('10'), 'BUY', NOW);

    expect(check.passed).toBe(true);
    // Since Phase 7 the portfolio limits are enforced rather than listed as
    // absent, and the check says which ones it ran.
    expect(check.checked).toContain('portfolio exposure');
    expect(check.checked).toContain('correlation');
    expect(check.checked).toContain('daily loss');
    expect(check.notYetEnforced).toHaveLength(0);
  });

  it('reports the absence of the whole-book layer rather than skipping it', async () => {
    // A service built without a risk engine — which production never is.
    const withoutRisk = new OrderService(
      db,
      container.access,
      container.audit,
      brokers,
      new TradingGate(db, brokers, container.health, container.dataQuality, container.calendar),
    );

    const check = await withoutRisk.preTradeCheck(portfolioId, 'AAPL', dec('10'), 'BUY', NOW);

    // A pre-trade check that silently omitted the portfolio limits would read
    // exactly like one that ran them.
    expect(check.checked.join(' ')).toContain('whole-book risk checks unavailable');
  });

  it('refuses an order that breaches a portfolio limit, not just a per-order one', async () => {
    await db.position.create({
      data: {
        portfolioId,
        symbol: 'AAPL',
        status: 'CLOSED',
        quantity: '0',
        averageEntryPrice: '100',
        realizedPnl: '-2500',
        openedAt: NOW,
        closedAt: NOW,
      },
    });

    const order = await orders.placeOrder(trader, {
      portfolioId,
      symbol: 'AAPL',
      side: 'BUY',
      quantity: '1',
      at: NOW,
    });

    // The fixture's daily loss limit is 2,000 and 2,500 has been lost today.
    expect(order.status).toBe(OrderStatus.REJECTED);
    expect(order.rejectionReason).toContain('daily loss');
  });

  it('refuses to trade at all while the kill switch is engaged', async () => {
    const admin = await createUser(db, { email: 'admin@test.local', role: UserRole.ADMIN });
    await container.killSwitch.engage({ ...admin }, { reason: 'testing that orders stop' });

    await expect(
      orders.placeOrder(trader, {
        portfolioId,
        symbol: 'AAPL',
        side: 'BUY',
        quantity: '1',
        at: NOW,
      }),
    ).rejects.toThrow();

    expect(await db.position.count()).toBe(0);
  });
});

describe('cancellation', () => {
  it('cannot cancel an order that never reached a broker', async () => {
    const order = await orders.placeOrder(trader, {
      portfolioId,
      symbol: 'AAPL',
      side: 'BUY',
      quantity: '500',
      at: NOW,
    });

    expect(order.status).toBe(OrderStatus.REJECTED);
    await expect(orders.cancel(trader, order.id)).rejects.toThrow(/never reached/);
  });

  it('records every status change as an event', async () => {
    const order = await orders.placeOrder(trader, {
      portfolioId,
      symbol: 'AAPL',
      side: 'BUY',
      quantity: '10',
      orderType: OrderType.MARKET,
      timeInForce: TimeInForce.DAY,
      at: NOW,
    });

    const events = await db.orderEvent.findMany({
      where: { orderId: order.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(events[0]?.toStatus).toBe(OrderStatus.CREATED);
    expect(events.map((event) => event.toStatus)).toContain(OrderStatus.SUBMITTED);
    expect(events.every((event) => event.actor === trader.email)).toBe(true);
  });
});

describe('the positions view', () => {
  it('marks on read and reports an unpriced symbol as unpriced, not flat', async () => {
    await db.position.createMany({
      data: [
        {
          portfolioId,
          symbol: 'AAPL',
          status: 'OPEN',
          quantity: '10',
          averageEntryPrice: '90',
          openedAt: NOW,
        },
        {
          portfolioId,
          symbol: 'NOPE',
          status: 'OPEN',
          quantity: '5',
          averageEntryPrice: '50',
          openedAt: NOW,
        },
      ],
    });

    const app = await buildTestApp();
    const user = await db.user.findUniqueOrThrow({ where: { email: 'trader@test.local' } });
    void user;
    const response = await app.app.inject({
      method: 'GET',
      url: `/api/trading/positions?portfolioId=${portfolioId}`,
      headers: (await login(app.app, 'trader@test.local')).headers(),
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    const { positions } = response.json() as {
      positions: { symbol: string; markPrice: string | null; unrealizedPnl: string | null }[];
    };

    const priced = positions.find((position) => position.symbol === 'AAPL');
    const unpriced = positions.find((position) => position.symbol === 'NOPE');

    // The fixture's stored close is 100 against a 90 basis: 100 of gain.
    expect(priced?.unrealizedPnl).toBe('100');
    // No stored price at all: null, so the UI can say "not priced" rather
    // than render a zero that reads as flat.
    expect(unpriced?.markPrice).toBeNull();
    expect(unpriced?.unrealizedPnl).toBeNull();
  });
});
