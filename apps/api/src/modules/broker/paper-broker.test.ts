import {
  AssetClass,
  OrderStatus,
  OrderType,
  TimeInForce,
  TradingEnvironment,
  dec,
} from '@zusu/shared';
import { describe, expect, it } from 'vitest';
import { PaperBroker, type PaperBar, type PaperPriceSource } from './paper-broker.js';
import type { PlaceOrderRequest } from './types.js';

/**
 * The paper venue.
 *
 * The tests that matter are the ones a flattering paper account would fail: a
 * fill priced from the bar the decision was made on, an order that always
 * fills in full regardless of volume, a stop that holds through a gap. Each is
 * asserted against.
 */

const BAR_MS = 300_000;
const START = Date.UTC(2026, 5, 1, 14, 0);

interface BarSpec {
  open: number;
  high?: number;
  low?: number;
  close: number;
  volume?: number;
}

function bars(specs: BarSpec[]): PaperBar[] {
  return specs.map((spec, i) => ({
    openTime: new Date(START + i * BAR_MS),
    open: dec(spec.open),
    high: dec(spec.high ?? Math.max(spec.open, spec.close)),
    low: dec(spec.low ?? Math.min(spec.open, spec.close)),
    close: dec(spec.close),
    volume: dec(spec.volume ?? 100_000),
  }));
}

/** A price source over a fixed list of bars, for one symbol. */
function source(list: PaperBar[]): PaperPriceSource {
  return {
    barsSince: (_symbol, since) =>
      Promise.resolve(list.filter((bar) => bar.openTime.getTime() > since.getTime())),
    latestBar: () => Promise.resolve(list[list.length - 1] ?? null),
  };
}

/** A venue whose clock sits at the given bar index. */
function venue(list: PaperBar[], atBarIndex: number, cash = '100000') {
  let clock = START + atBarIndex * BAR_MS;
  const broker = new PaperBroker({
    startingCash: cash,
    prices: source(list),
    now: () => clock,
  });
  return {
    broker,
    advanceTo(index: number) {
      clock = START + index * BAR_MS;
    },
  };
}

function request(overrides: Partial<PlaceOrderRequest> = {}): PlaceOrderRequest {
  return {
    idempotencyKey: `key-${Math.random().toString(36).slice(2)}`,
    symbol: 'AAPL',
    assetClass: AssetClass.EQUITY,
    side: 'BUY',
    orderType: OrderType.MARKET,
    timeInForce: TimeInForce.DAY,
    quantity: dec(100),
    ...overrides,
  };
}

describe('the environment boundary', () => {
  it('is a paper adapter and says so', () => {
    const { broker } = venue(bars([{ open: 100, close: 100 }]), 0);
    expect(broker.environment).toBe(TradingEnvironment.PAPER);
    expect(broker.kind).toBe('PAPER');
  });

  it('refuses anything but equities', async () => {
    const { broker } = venue(bars([{ open: 100, close: 100 }]), 0);
    await expect(broker.placeOrder(request({ assetClass: AssetClass.OPTION }))).rejects.toThrow(
      /equities only/,
    );
  });
});

describe('look-ahead', () => {
  it('will not fill from the bar the order was submitted on', async () => {
    // Bar 1 closes at 101 and the order arrives during bar 1. Bar 2 opens at
    // 150: a venue that filled from bar 1 would hand back 101.
    const list = bars([
      { open: 99, close: 99 },
      { open: 100, close: 101 },
      { open: 150, close: 151 },
    ]);
    const { broker, advanceTo } = venue(list, 1);

    const placed = await broker.placeOrder(request({ quantity: dec(10) }));
    expect(placed.filledQty.toString()).toBe('0');

    advanceTo(2);
    const settled = await broker.getOrderStatus(placed.brokerOrderId);
    expect(Number(settled.averageFillPrice?.toString())).toBeGreaterThan(149);
  });

  it('does not fill before the venue has acknowledged it', async () => {
    const list = bars([
      { open: 100, close: 100 },
      { open: 100, close: 100 },
    ]);
    // The clock sits exactly on bar 1's open, so the only bar after
    // submission opened before the acknowledgement latency elapsed.
    const { broker } = venue(list, 1);

    const placed = await broker.placeOrder(request());
    expect(placed.status).toBe(OrderStatus.ACKNOWLEDGED);
    expect(placed.filledQty.toString()).toBe('0');
  });

  it('never fills from a bar in the future of the venue clock', async () => {
    const list = bars([
      { open: 100, close: 100 },
      { open: 100, close: 100 },
      { open: 100, close: 100 },
      { open: 100, close: 100 },
    ]);
    const { broker } = venue(list, 0);

    const placed = await broker.placeOrder(request());
    // Bars 1-3 exist in the source but have not happened yet.
    expect(placed.filledQty.toString()).toBe('0');
  });
});

describe('liquidity', () => {
  it('fills across several bars when the order exceeds a bar’s participation', async () => {
    // 5% of a 1,000-share bar is 50 shares, so 120 needs three bars.
    const list = bars([
      { open: 100, close: 100, volume: 1_000 },
      { open: 100, close: 100, volume: 1_000 },
      { open: 100, close: 100, volume: 1_000 },
      { open: 100, close: 100, volume: 1_000 },
      { open: 100, close: 100, volume: 1_000 },
    ]);
    const { broker, advanceTo } = venue(list, 0);

    const placed = await broker.placeOrder(request({ quantity: dec(120) }));
    advanceTo(1);
    const partial = await broker.getOrderStatus(placed.brokerOrderId);
    expect(partial.status).toBe(OrderStatus.PARTIALLY_FILLED);
    expect(partial.filledQty.toString()).toBe('50');

    advanceTo(4);
    const filled = await broker.getOrderStatus(placed.brokerOrderId);
    expect(filled.status).toBe(OrderStatus.FILLED);
    expect(filled.filledQty.toString()).toBe('120');
    // Three fills, not one: a paper account that fills everything at once
    // reports an execution quality nobody has.
    expect(filled.executions).toHaveLength(3);
  });
});

describe('pricing', () => {
  it('pays the ask on a buy and receives the bid on a sell', async () => {
    const list = bars([
      { open: 100, close: 100 },
      { open: 100, close: 100 },
      { open: 100, close: 100 },
    ]);
    const { broker, advanceTo } = venue(list, 0);

    const buy = await broker.placeOrder(request({ quantity: dec(10) }));
    advanceTo(1);
    const buyFilled = await broker.getOrderStatus(buy.brokerOrderId);
    expect(Number(buyFilled.averageFillPrice?.toString())).toBeGreaterThan(100);

    const sell = await broker.placeOrder(request({ quantity: dec(10), side: 'SELL' }));
    advanceTo(2);
    const sellFilled = await broker.getOrderStatus(sell.brokerOrderId);
    expect(Number(sellFilled.averageFillPrice?.toString())).toBeLessThan(100);
  });

  it('slips more as the order takes more of the bar', async () => {
    const thin = bars([
      { open: 100, close: 100, volume: 400 },
      { open: 100, close: 100, volume: 400 },
    ]);
    const deep = bars([
      { open: 100, close: 100, volume: 10_000_000 },
      { open: 100, close: 100, volume: 10_000_000 },
    ]);

    const thinVenue = venue(thin, 0);
    const thinOrder = await thinVenue.broker.placeOrder(request({ quantity: dec(20) }));
    thinVenue.advanceTo(1);
    const thinFill = await thinVenue.broker.getOrderStatus(thinOrder.brokerOrderId);

    const deepVenue = venue(deep, 0);
    const deepOrder = await deepVenue.broker.placeOrder(request({ quantity: dec(20) }));
    deepVenue.advanceTo(1);
    const deepFill = await deepVenue.broker.getOrderStatus(deepOrder.brokerOrderId);

    expect(
      Number(thinFill.averageFillPrice?.toString()) > Number(deepFill.averageFillPrice?.toString()),
    ).toBe(true);
  });

  it('charges regulatory fees on a sale and none on a purchase', async () => {
    const list = bars([
      { open: 100, close: 100 },
      { open: 100, close: 100 },
      { open: 100, close: 100 },
    ]);
    const { broker, advanceTo } = venue(list, 0);

    const buy = await broker.placeOrder(request({ quantity: dec(10) }));
    advanceTo(1);
    expect((await broker.getOrderStatus(buy.brokerOrderId)).fees.toString()).toBe('0');

    const sell = await broker.placeOrder(request({ quantity: dec(10), side: 'SELL' }));
    advanceTo(2);
    expect((await broker.getOrderStatus(sell.brokerOrderId)).fees.greaterThan(0)).toBe(true);
  });
});

describe('limits and stops', () => {
  it('does not fill a limit the market never reached', async () => {
    const list = bars([
      { open: 100, close: 100 },
      { open: 100, high: 101, low: 99.5, close: 100 },
    ]);
    const { broker, advanceTo } = venue(list, 0);

    const placed = await broker.placeOrder(
      request({ orderType: OrderType.LIMIT, limitPrice: dec(95), quantity: dec(10) }),
    );
    advanceTo(1);
    const settled = await broker.getOrderStatus(placed.brokerOrderId);

    expect(settled.filledQty.toString()).toBe('0');
    expect(settled.status).toBe(OrderStatus.ACKNOWLEDGED);
  });

  it('fills a limit the market traded through, at the better price', async () => {
    const list = bars([
      { open: 100, close: 100 },
      { open: 90, high: 91, low: 89, close: 90 },
    ]);
    const { broker, advanceTo } = venue(list, 0);

    const placed = await broker.placeOrder(
      request({ orderType: OrderType.LIMIT, limitPrice: dec(95), quantity: dec(10) }),
    );
    advanceTo(1);
    const settled = await broker.getOrderStatus(placed.brokerOrderId);

    // The bar opened at 90, below the 95 limit, so the fill is near 90 — a
    // venue that filled at the limit would be keeping the difference.
    expect(Number(settled.averageFillPrice?.toString())).toBeLessThan(91);
  });

  it('does not trigger a stop the market never reached', async () => {
    const list = bars([
      { open: 100, close: 100 },
      { open: 100, high: 101, low: 99, close: 100 },
    ]);
    const { broker, advanceTo } = venue(list, 0);

    const placed = await broker.placeOrder(
      request({ orderType: OrderType.STOP, stopPrice: dec(95), side: 'SELL', quantity: dec(10) }),
    );
    advanceTo(1);
    expect((await broker.getOrderStatus(placed.brokerOrderId)).filledQty.toString()).toBe('0');
  });

  it('fills a gapped stop at the open, not at the stop', async () => {
    const list = bars([
      { open: 100, close: 100 },
      { open: 80, high: 81, low: 79, close: 80 },
    ]);
    const { broker, advanceTo } = venue(list, 0);

    const placed = await broker.placeOrder(
      request({ orderType: OrderType.STOP, stopPrice: dec(95), side: 'SELL', quantity: dec(10) }),
    );
    advanceTo(1);
    const settled = await broker.getOrderStatus(placed.brokerOrderId);

    // Near 80, not 95. Claiming the stop would invent liquidity that was
    // never there.
    expect(Number(settled.averageFillPrice?.toString())).toBeLessThan(81);
  });
});

describe('idempotency and cancellation', () => {
  it('returns the same order for a repeated client order id', async () => {
    const list = bars([
      { open: 100, close: 100 },
      { open: 100, close: 100 },
    ]);
    const { broker } = venue(list, 0);

    const key = 'the-same-key';
    const first = await broker.placeOrder(request({ idempotencyKey: key }));
    const second = await broker.placeOrder(request({ idempotencyKey: key }));

    expect(second.brokerOrderId).toBe(first.brokerOrderId);
    expect((await broker.getOrders()).length).toBe(1);
  });

  it('cannot cancel a fill that already happened', async () => {
    const list = bars([
      { open: 100, close: 100 },
      { open: 100, close: 100 },
    ]);
    const { broker, advanceTo } = venue(list, 0);

    const placed = await broker.placeOrder(request({ quantity: dec(10) }));
    advanceTo(1);

    await expect(broker.cancelOrder(placed.brokerOrderId)).rejects.toThrow(/already FILLED/);
  });

  it('cancels an unfilled order', async () => {
    const list = bars([
      { open: 100, close: 100 },
      { open: 100, high: 101, low: 99, close: 100 },
    ]);
    const { broker } = venue(list, 0);

    const placed = await broker.placeOrder(
      request({ orderType: OrderType.LIMIT, limitPrice: dec(50) }),
    );
    const cancelled = await broker.cancelOrder(placed.brokerOrderId);
    expect(cancelled.status).toBe(OrderStatus.CANCELLED);
  });
});

describe('account and positions', () => {
  it('moves cash and builds a position from fills', async () => {
    const list = bars([
      { open: 100, close: 100 },
      { open: 100, close: 100 },
    ]);
    const { broker, advanceTo } = venue(list, 0, '10000');

    const placed = await broker.placeOrder(request({ quantity: dec(50) }));
    advanceTo(1);
    await broker.getOrderStatus(placed.brokerOrderId);

    const account = await broker.getAccount();
    expect(Number(account.cash.toString())).toBeLessThan(10_000);
    // Equity is roughly unchanged: cash became shares, minus the costs.
    expect(Number(account.equity.toString())).toBeLessThan(10_000);
    expect(Number(account.equity.toString())).toBeGreaterThan(9_900);

    const positions = await broker.getPositions();
    expect(positions[0]?.symbol).toBe('AAPL');
    expect(positions[0]?.quantity.toString()).toBe('50');
  });

  it('offers no margin: buying power is cash', async () => {
    const { broker } = venue(bars([{ open: 100, close: 100 }]), 0, '7500');
    const account = await broker.getAccount();
    expect(account.buyingPower.toString()).toBe(account.cash.toString());
  });

  it('realises profit when a position is closed', async () => {
    const list = bars([
      { open: 100, close: 100 },
      { open: 100, close: 100 },
      { open: 120, close: 120 },
      { open: 120, close: 120 },
    ]);
    const { broker, advanceTo } = venue(list, 0, '20000');

    const buy = await broker.placeOrder(request({ quantity: dec(100) }));
    advanceTo(1);
    await broker.getOrderStatus(buy.brokerOrderId);

    advanceTo(2);
    const sell = await broker.placeOrder(request({ quantity: dec(100), side: 'SELL' }));
    advanceTo(3);
    await broker.getOrderStatus(sell.brokerOrderId);

    const account = await broker.getAccount();
    // Bought near 100, sold near 120, so cash is up around 2,000 less costs.
    expect(Number(account.cash.toString())).toBeGreaterThan(21_800);
    expect(await broker.getPositions()).toHaveLength(0);
  });

  it('hands every fill to the caller once, for persisting as a paper trade', async () => {
    const list = bars([
      { open: 100, close: 100 },
      { open: 100, close: 100 },
    ]);
    const { broker, advanceTo } = venue(list, 0);

    const placed = await broker.placeOrder(request({ quantity: dec(10) }));
    advanceTo(1);
    await broker.getOrderStatus(placed.brokerOrderId);

    const fills = broker.drainFills();
    expect(fills).toHaveLength(1);
    expect(fills[0]?.spreadCost.greaterThan(0)).toBe(true);
    // Drained means drained: a second call must not re-report the same fill,
    // or a caller polling the venue would double-count it.
    expect(broker.drainFills()).toHaveLength(0);
  });
});

describe('quoting', () => {
  it('quotes a spread around the newest stored bar', async () => {
    const { broker } = venue(bars([{ open: 100, close: 105 }]), 0);
    const quote = await broker.getQuote('AAPL');

    expect(Number(quote.bid.toString())).toBeLessThan(105);
    expect(Number(quote.ask.toString())).toBeGreaterThan(105);
    // Both clocks, always: the bar's own time and this process's.
    expect(quote.sourceTimestamp).toBeInstanceOf(Date);
    expect(quote.receivedTimestamp).toBeInstanceOf(Date);
  });

  it('refuses to quote a symbol it has no bar for', async () => {
    const broker = new PaperBroker({
      prices: { barsSince: () => Promise.resolve([]), latestBar: () => Promise.resolve(null) },
    });
    await expect(broker.getQuote('NOPE')).rejects.toThrow(/cannot quote/);
  });
});
