import { AssetClass, OrderSide, OrderStatus, OrderType, TimeInForce, dec } from '@zusu/shared';
import type Decimal from 'decimal.js';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { BrokerRegistry } from '../../src/modules/broker/broker-registry.js';
import { ReconciliationService } from '../../src/modules/broker/reconciliation.service.js';
import type {
  BrokerAccountSnapshot,
  BrokerAdapter,
  BrokerOrder,
  BrokerPosition,
} from '../../src/modules/broker/types.js';
import { disconnectTestDb, resetDatabase, testDb } from '../helpers/db.js';
import { createPortfolio } from '../helpers/fixtures.js';

/**
 * Reconciliation (§26).
 *
 * The property under test is what the service *does not* do. Every case here
 * ends the same way: a difference is recorded, an alert is raised, and both
 * records are left exactly as they were. A reconciler that corrects one side
 * destroys the only evidence that the two ever disagreed.
 */

const db = testDb();
const NOW = new Date('2026-07-15T14:00:00Z');

let portfolioId: string;
let brokerAccountId: string;

/** A broker whose answers the test dictates, so a disagreement can be staged. */
class StubBroker implements Partial<BrokerAdapter> {
  cash = dec('100000');
  positions: BrokerPosition[] = [];
  orders: BrokerOrder[] = [];

  getAccount(): Promise<BrokerAccountSnapshot> {
    return Promise.resolve({
      accountId: 'stub',
      environment: 'DEMO' as const,
      currency: 'USD',
      cash: this.cash,
      buyingPower: this.cash,
      equity: this.cash,
      maintenanceMargin: dec(0),
      isPatternDayTrader: false,
      updatedAt: NOW,
    });
  }

  getPositions(): Promise<BrokerPosition[]> {
    return Promise.resolve(this.positions);
  }

  getOrders(): Promise<BrokerOrder[]> {
    return Promise.resolve(this.orders);
  }
}

let broker: StubBroker;
let service: ReconciliationService;

function brokerPosition(symbol: string, quantity: string, entry: string): BrokerPosition {
  const qty = dec(quantity);
  const price = dec(entry);
  return {
    symbol,
    assetClass: AssetClass.EQUITY,
    quantity: qty,
    averageEntryPrice: price,
    markPrice: price,
    marketValue: qty.times(price) as unknown as Decimal,
    unrealizedPnl: dec(0),
    updatedAt: NOW,
  };
}

function brokerOrder(symbol: string, clientOrderId: string): BrokerOrder {
  return {
    brokerOrderId: `rh-${clientOrderId}`,
    clientOrderId,
    symbol,
    assetClass: AssetClass.EQUITY,
    side: OrderSide.BUY,
    orderType: OrderType.MARKET,
    timeInForce: TimeInForce.DAY,
    status: OrderStatus.FILLED,
    requestedQty: dec(10),
    filledQty: dec(10),
    averageFillPrice: dec('101.00'),
    limitPrice: null,
    stopPrice: null,
    fees: dec(0),
    rejectReason: null,
    submittedAt: NOW,
    updatedAt: NOW,
    executions: [],
  };
}

async function openPosition(symbol: string, quantity: string, entry: string): Promise<void> {
  await db.position.create({
    data: {
      portfolioId,
      symbol,
      assetClass: 'EQUITY',
      status: 'OPEN',
      quantity,
      averageEntryPrice: entry,
    },
  });
}

beforeEach(async () => {
  await resetDatabase();
  const portfolio = await createPortfolio(db, { name: 'Reconciliation', initialCapital: '100000' });
  portfolioId = portfolio.id;
  const account = await db.brokerAccount.create({
    data: {
      portfolioId,
      environment: 'DEMO',
      broker: 'DEMO',
      label: 'Stub',
      connectionState: 'CONNECTED',
    },
  });
  brokerAccountId = account.id;

  broker = new StubBroker();
  const registry = {
    forPortfolio: () => broker as unknown as BrokerAdapter,
  } as unknown as BrokerRegistry;
  service = new ReconciliationService(db, registry);
});

afterAll(async () => {
  await disconnectTestDb();
});

describe('reconciliation', () => {
  it('reports agreement when both records match', async () => {
    await openPosition('AAPL', '10', '100');
    broker.positions = [brokerPosition('AAPL', '10', '100')];

    const result = await service.run(portfolioId);

    expect(result.succeeded).toBe(true);
    expect(result.differences).toEqual([]);
    expect(result.detail).toContain('agree');
    // A clean run is still recorded: "we checked and it matched" is evidence.
    const stored = await db.reconciliation.findMany({ where: { brokerAccountId } });
    expect(stored).toHaveLength(1);
    expect(stored[0]?.succeeded).toBe(true);
    // No alert for a clean run.
    expect(await db.riskEvent.count({ where: { portfolioId } })).toBe(0);
  });

  it('finds cash drift and corrects neither side', async () => {
    broker.cash = dec('99750.25');

    const result = await service.run(portfolioId);

    expect(result.cashMismatch).toBe(true);
    const difference = result.differences.find((d) => d.kind === 'CASH');
    expect(difference?.ours).toBe('100000');
    expect(difference?.theirs).toBe('99750.25');
    expect(difference?.detail).toContain('a person decides');

    // The record this platform keeps is untouched. That is the whole rule.
    const portfolio = await db.portfolio.findUniqueOrThrow({ where: { id: portfolioId } });
    expect(portfolio.cashBalance.toString()).toBe('100000');
  });

  it('treats a sub-cent cash difference as rounding, not drift', async () => {
    broker.cash = dec('99999.995');
    const result = await service.run(portfolioId);
    expect(result.cashMismatch).toBe(false);
    expect(result.succeeded).toBe(true);
  });

  it('reports a position the broker has and this platform does not', async () => {
    broker.positions = [brokerPosition('TSLA', '25', '210.5')];

    const result = await service.run(portfolioId);

    const difference = result.differences.find((d) => d.kind === 'POSITION_MISSING_HERE');
    expect(difference?.symbol).toBe('TSLA');
    expect(difference?.theirs).toBe('25');
    expect(difference?.ours).toBeNull();
    expect(result.positionMismatch).toBe(true);

    // Not adopted. A position appearing here would be a trade nobody made.
    expect(await db.position.count({ where: { portfolioId } })).toBe(0);
  });

  it('reports a position this platform has and the broker does not', async () => {
    await openPosition('MSFT', '40', '390');

    const result = await service.run(portfolioId);

    const difference = result.differences.find((d) => d.kind === 'POSITION_MISSING_AT_BROKER');
    expect(difference?.symbol).toBe('MSFT');
    expect(difference?.ours).toBe('40');
    expect(difference?.detail).toContain('worse direction');

    // The position is not closed, deleted or zeroed by the reconciler.
    const position = await db.position.findFirstOrThrow({ where: { portfolioId, symbol: 'MSFT' } });
    expect(position.status).toBe('OPEN');
    expect(position.quantity.toString()).toBe('40');
  });

  it('separates a quantity difference from a cost-basis difference', async () => {
    await openPosition('NVDA', '15', '120.00');
    broker.positions = [brokerPosition('NVDA', '18', '124.00')];

    const result = await service.run(portfolioId);

    const kinds = result.differences.map((d) => d.kind);
    expect(kinds).toContain('POSITION_QUANTITY');
    expect(kinds).toContain('POSITION_PRICE');
    const price = result.differences.find((d) => d.kind === 'POSITION_PRICE');
    expect(price?.detail).toContain('Cost basis drift');
  });

  it('identifies an order placed elsewhere rather than adopting it', async () => {
    broker.orders = [brokerOrder('AMD', 'placed-in-the-app')];

    const result = await service.run(portfolioId);

    const difference = result.differences.find((d) => d.kind === 'ORDER_PLACED_ELSEWHERE');
    expect(difference?.symbol).toBe('AMD');
    expect(difference?.detail).toContain('reported rather than adopted');
    expect(result.orderMismatch).toBe(true);

    // Adopting it would attribute a person's own decision to a strategy, and
    // every statistic about that strategy would then be about someone else.
    expect(await db.order.count({ where: { portfolioId } })).toBe(0);
  });

  it('recognises an order it did place by its idempotency key', async () => {
    await db.order.create({
      data: {
        idempotencyKey: 'signal:known',
        correlationId: portfolioId,
        portfolioId,
        brokerAccountId,
        environment: 'DEMO',
        symbol: 'AMD',
        side: 'BUY',
        orderType: 'MARKET',
        status: 'FILLED',
        requestedQty: '10',
        filledQty: '10',
      },
    });
    broker.orders = [brokerOrder('AMD', 'signal:known')];

    const result = await service.run(portfolioId);

    expect(result.orderMismatch).toBe(false);
    expect(result.differences).toEqual([]);
  });

  it('raises a critical alert for a position mismatch and a warning otherwise', async () => {
    broker.cash = dec('90000');
    await service.run(portfolioId);
    const cashOnly = await db.riskEvent.findFirstOrThrow({ where: { portfolioId } });
    expect(cashOnly.type).toBe('RECONCILIATION_MISMATCH');
    expect(cashOnly.severity).toBe('WARNING');

    await openPosition('MSFT', '40', '390');
    await service.run(portfolioId);
    const events = await db.riskEvent.findMany({
      where: { portfolioId },
      orderBy: { createdAt: 'desc' },
    });
    expect(events[0]?.severity).toBe('CRITICAL');
  });

  it('lists past runs newest first', async () => {
    await service.run(portfolioId);
    broker.cash = dec('12345');
    await service.run(portfolioId);

    const rows = await service.recent(portfolioId);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.cashMismatch).toBe(true);
    expect(rows[1]?.cashMismatch).toBe(false);
    expect(rows[0]?.differences[0]?.kind).toBe('CASH');
  });

  it('still reports differences for a portfolio with no linked broker account', async () => {
    await db.reconciliation.deleteMany({ where: { brokerAccountId } });
    await db.brokerAccount.delete({ where: { id: brokerAccountId } });
    broker.cash = dec('1');

    const result = await service.run(portfolioId);

    expect(result.cashMismatch).toBe(true);
    expect(result.id).toBe('unstored');
    expect(result.detail).toContain('not stored');
    expect(await service.recent(portfolioId)).toEqual([]);
  });
});
