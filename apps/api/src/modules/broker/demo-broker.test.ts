import { beforeEach, describe, expect, it } from 'vitest';
import { AssetClass, OrderStatus, OrderType, TimeInForce, dec } from '@zusu/shared';
import { DemoBroker } from './demo-broker.js';
import { MarketSimulator } from './market-simulator.js';
import { BrokerError } from './types.js';

/** A Wednesday at 15:00 UTC — inside the simulated regular session. */
const SESSION_START = Date.UTC(2026, 8, 9, 15, 0, 0);

function makeBroker(startingCash = 100_000) {
  let now = SESSION_START;
  const clock = () => now;
  const broker = new DemoBroker({
    startingCash,
    seed: 4242,
    now: clock,
    simulator: new MarketSimulator({ seed: 4242, now: clock }),
  });
  return {
    broker,
    advance(ms: number) {
      now += ms;
    },
    now: () => now,
  };
}

const marketBuy = (quantity: number, key: string, symbol = 'AAPL') => ({
  idempotencyKey: key,
  symbol,
  assetClass: AssetClass.EQUITY,
  side: 'BUY' as const,
  orderType: OrderType.MARKET,
  timeInForce: TimeInForce.DAY,
  quantity: dec(quantity),
});

describe('DemoBroker — idempotency', () => {
  it('never creates a second order for a repeated idempotency key', async () => {
    const { broker, advance } = makeBroker();
    const first = await broker.placeOrder(marketBuy(10, 'signal-1'));
    advance(5_000);

    // Simulates a caller that crashed after submitting and retried on restart.
    const retry = await broker.placeOrder(marketBuy(10, 'signal-1'));

    expect(retry.brokerOrderId).toBe(first.brokerOrderId);
    const orders = await broker.getOrders();
    expect(orders).toHaveLength(1);
  });

  it('rejects an order with no idempotency key', async () => {
    const { broker } = makeBroker();
    await expect(broker.placeOrder(marketBuy(1, ''))).rejects.toBeInstanceOf(BrokerError);
  });

  it('treats different keys for the same intent as different orders', async () => {
    const { broker } = makeBroker();
    await broker.placeOrder(marketBuy(1, 'a'));
    await broker.placeOrder(marketBuy(1, 'b'));
    expect(await broker.getOrders()).toHaveLength(2);
  });
});

describe('DemoBroker — order lifecycle', () => {
  it('does not fill before the venue has acknowledged the order', async () => {
    const { broker } = makeBroker();
    const order = await broker.placeOrder(marketBuy(5, 'k1'));
    // A broker accepting an order is not a fill: status stays SUBMITTED.
    expect(order.status).toBe(OrderStatus.SUBMITTED);
    expect(order.filledQty.toNumber()).toBe(0);
  });

  it('fills a small market order once time passes', async () => {
    const { broker, advance } = makeBroker();
    const submitted = await broker.placeOrder(marketBuy(5, 'k2'));
    advance(2_000);

    const filled = await broker.getOrderStatus(submitted.brokerOrderId);
    expect(filled.status).toBe(OrderStatus.FILLED);
    expect(filled.filledQty.toNumber()).toBe(5);
    expect(filled.averageFillPrice?.toNumber()).toBeGreaterThan(0);
    expect(filled.executions).toHaveLength(1);
  });

  it('fills a large order in slices, exposing a genuine partial fill', async () => {
    const { broker, advance } = makeBroker(50_000_000);
    // Liquidity for MSFT is ~24 shares/second, so 1,000 shares cannot fill at once.
    const submitted = await broker.placeOrder(marketBuy(1_000, 'big', 'MSFT'));

    advance(2_000);
    const partial = await broker.getOrderStatus(submitted.brokerOrderId);
    expect(partial.status).toBe(OrderStatus.PARTIALLY_FILLED);
    expect(partial.filledQty.toNumber()).toBeGreaterThan(0);
    expect(partial.filledQty.toNumber()).toBeLessThan(1_000);

    advance(120_000);
    const complete = await broker.getOrderStatus(submitted.brokerOrderId);
    expect(complete.status).toBe(OrderStatus.FILLED);
    expect(complete.filledQty.toNumber()).toBe(1_000);
    expect(complete.executions.length).toBeGreaterThan(1);
    // The average fill price is a true weighted average of the slices.
    const weighted = complete.executions
      .reduce((sum, e) => sum.plus(e.price.times(e.quantity)), dec(0))
      .dividedBy(complete.filledQty);
    expect(complete.averageFillPrice?.minus(weighted).abs().toNumber()).toBeLessThan(1e-6);
  });

  it('leaves an unmarketable limit order resting', async () => {
    const { broker, advance } = makeBroker();
    const quote = await broker.getQuote('AAPL');
    const order = await broker.placeOrder({
      ...marketBuy(5, 'limit-1'),
      orderType: OrderType.LIMIT,
      limitPrice: quote.price.times(0.5),
    });
    advance(30_000);

    const status = await broker.getOrderStatus(order.brokerOrderId);
    expect(status.status).toBe(OrderStatus.ACKNOWLEDGED);
    expect(status.filledQty.toNumber()).toBe(0);
  });

  it('fills a marketable limit order at or better than its limit', async () => {
    const { broker, advance } = makeBroker();
    const quote = await broker.getQuote('AAPL');
    const order = await broker.placeOrder({
      ...marketBuy(3, 'limit-2'),
      orderType: OrderType.LIMIT,
      limitPrice: quote.ask.times(1.05),
    });
    advance(3_000);

    const status = await broker.getOrderStatus(order.brokerOrderId);
    expect(status.status).toBe(OrderStatus.FILLED);
    expect(status.averageFillPrice?.lte(quote.ask.times(1.05))).toBe(true);
  });

  it('cancels a resting order and reports the real state of a filled one', async () => {
    const { broker, advance } = makeBroker();
    const quote = await broker.getQuote('AAPL');
    const resting = await broker.placeOrder({
      ...marketBuy(5, 'cancel-1'),
      orderType: OrderType.LIMIT,
      limitPrice: quote.price.times(0.5),
    });
    advance(1_000);
    expect((await broker.cancelOrder(resting.brokerOrderId)).status).toBe(OrderStatus.CANCELLED);

    const fillsFast = await broker.placeOrder(marketBuy(2, 'cancel-2'));
    advance(5_000);
    // The cancel lost the race; the caller is told FILLED, not CANCELLED.
    const raced = await broker.cancelOrder(fillsFast.brokerOrderId);
    expect(raced.status).toBe(OrderStatus.FILLED);
  });

  it('rejects a buy the account cannot pay for', async () => {
    const { broker, advance } = makeBroker(100);
    const order = await broker.placeOrder(marketBuy(50, 'poor'));
    advance(3_000);

    const status = await broker.getOrderStatus(order.brokerOrderId);
    expect(status.status).toBe(OrderStatus.REJECTED);
    expect(status.rejectReason).toMatch(/buying power/i);
    expect(status.filledQty.toNumber()).toBe(0);
  });

  it('refuses to short a position the demo account does not hold', async () => {
    const { broker } = makeBroker();
    const order = await broker.placeOrder({ ...marketBuy(5, 'short'), side: 'SELL' });
    expect(order.status).toBe(OrderStatus.REJECTED);
    expect(order.rejectReason).toMatch(/short selling/i);
  });

  it('reports an unknown order rather than inventing one', async () => {
    const { broker } = makeBroker();
    await expect(broker.getOrderStatus('demo-nope')).rejects.toBeInstanceOf(BrokerError);
  });
});

describe('DemoBroker — cash, positions and fees', () => {
  let harness: ReturnType<typeof makeBroker>;

  beforeEach(() => {
    harness = makeBroker();
  });

  it('debits cash and opens a position on a buy', async () => {
    const { broker, advance } = harness;
    const before = await broker.getAccount();

    const order = await broker.placeOrder(marketBuy(10, 'buy-1'));
    advance(3_000);
    const filled = await broker.getOrderStatus(order.brokerOrderId);
    const after = await broker.getAccount();

    const spent = filled.averageFillPrice?.times(filled.filledQty) ?? dec(0);
    expect(before.cash.minus(after.cash).minus(spent).abs().toNumber()).toBeLessThan(0.01);

    const positions = await broker.getPositions();
    expect(positions).toHaveLength(1);
    expect(positions[0]?.quantity.toNumber()).toBe(10);
  });

  it('charges regulatory fees on sells and none on buys', async () => {
    const { broker, advance } = harness;
    const buy = await broker.placeOrder(marketBuy(10, 'fee-buy'));
    advance(3_000);
    expect((await broker.getOrderStatus(buy.brokerOrderId)).fees.toNumber()).toBe(0);

    const sell = await broker.placeOrder({ ...marketBuy(10, 'fee-sell'), side: 'SELL' });
    advance(3_000);
    const sold = await broker.getOrderStatus(sell.brokerOrderId);
    expect(sold.status).toBe(OrderStatus.FILLED);
    expect(sold.fees.toNumber()).toBeGreaterThan(0);
  });

  it('realises P&L and closes the position on a full exit', async () => {
    const { broker, advance } = harness;
    const buy = await broker.placeOrder(marketBuy(10, 'rt-buy'));
    advance(60_000);
    await broker.getOrderStatus(buy.brokerOrderId);

    const sell = await broker.placeOrder({ ...marketBuy(10, 'rt-sell'), side: 'SELL' });
    advance(5_000);
    await broker.getOrderStatus(sell.brokerOrderId);

    expect(await broker.getPositions()).toHaveLength(0);
  });

  it('is bound to the DEMO environment and says so', async () => {
    const account = await harness.broker.getAccount();
    expect(harness.broker.environment).toBe('DEMO');
    expect(account.environment).toBe('DEMO');
    expect((await harness.broker.getQuote('AAPL')).provider).toBe('demo-simulator');
  });
});

describe('DemoBroker — options chain', () => {
  it('produces internally consistent contracts', async () => {
    const { broker } = makeBroker();
    const chain = await broker.getOptionsChain('AAPL');
    expect(chain.contracts.length).toBeGreaterThan(10);

    for (const contract of chain.contracts) {
      expect(contract.bid.lte(contract.ask)).toBe(true);
      expect(contract.impliedVolatility.gt(0)).toBe(true);
      // Calls have positive delta, puts negative — never the other way round.
      expect(contract.delta.toNumber()).toBeGreaterThanOrEqual(contract.isCall ? 0 : -1);
      expect(contract.delta.toNumber()).toBeLessThanOrEqual(contract.isCall ? 1 : 0);
      expect(contract.gamma.toNumber()).toBeGreaterThanOrEqual(0);
    }
  });
});
