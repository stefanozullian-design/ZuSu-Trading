import {
  AssetClass,
  OrderStatus,
  OrderType,
  TimeInForce,
  TradingEnvironment,
  dec,
} from '@zusu/shared';
import { describe, expect, it } from 'vitest';
import type { PlaceOrderRequest } from '../types.js';
import { RobinhoodBroker, syntheticExecutionId, translateState } from './robinhood-broker.js';
import {
  UnconfiguredRobinhoodTransport,
  type RobinhoodOrder,
  type RobinhoodTransport,
} from './transport.js';

/**
 * The live Robinhood adapter, against a fake transport.
 *
 * **Nothing here has spoken to the live API**: this deployment has no
 * credentials. What these tests pin is the translation and the gates — the
 * three independent conditions that must all hold before a real order could
 * ever leave this process, and the refusals when they do not.
 */

const order = (overrides: Partial<RobinhoodOrder> = {}): RobinhoodOrder => ({
  id: 'rh-order-1',
  ref_id: 'our-key-1',
  state: 'confirmed',
  symbol: 'AAPL',
  side: 'buy',
  type: 'limit',
  time_in_force: 'gfd',
  quantity: '10',
  cumulative_quantity: '0',
  average_price: null,
  price: '185.00',
  stop_price: null,
  fees: '0',
  reject_reason: null,
  created_at: '2026-09-11T14:30:00.000Z',
  updated_at: '2026-09-11T14:30:01.000Z',
  placed_agent: 'agentic',
  ...overrides,
});

function transport(overrides: Partial<RobinhoodTransport> = {}) {
  const placed: unknown[] = [];
  const base: RobinhoodTransport = {
    getAccount: () =>
      Promise.resolve({
        account_number: 'RH-1',
        agentic_allowed: true,
        option_level: 'option_level_3',
        buying_power: '50000',
        cash: '50000',
        equity: '75000',
        type: 'margin',
      }),
    getPositions: () =>
      Promise.resolve([
        { symbol: 'AAPL', quantity: '20', average_buy_price: '180', market_value: '3720' },
      ]),
    getOrders: () => Promise.resolve([order()]),
    getOrder: () => Promise.resolve(order()),
    getQuote: () =>
      Promise.resolve({
        symbol: 'AAPL',
        last_trade_price: '186.00',
        bid_price: '185.98',
        ask_price: '186.02',
        bid_size: '300',
        ask_size: '200',
        volume: '1000000',
        updated_at: '2026-09-11T19:55:00.000Z',
      }),
    placeEquityOrder: (request) => {
      placed.push(request);
      return Promise.resolve(order({ ref_id: request.ref_id }));
    },
    placeOptionOrder: () => Promise.resolve(order()),
    cancelOrder: () => Promise.resolve(order({ state: 'cancelled' })),
    ...overrides,
  };
  return { transport: base, placed };
}

function broker(
  options: {
    transport?: RobinhoodTransport;
    liveOrdersEnabled?: boolean;
    allowLiveTrading?: boolean;
    session?: 'regular_hours' | 'extended_hours' | 'all_day_hours';
  } = {},
) {
  return new RobinhoodBroker({
    accountNumber: 'RH-1',
    transport: options.transport ?? transport().transport,
    liveOrdersEnabled: options.liveOrdersEnabled ?? true,
    allowLiveTrading: options.allowLiveTrading ?? true,
    sessionAt: () => options.session ?? 'regular_hours',
  });
}

const request = (overrides: Partial<PlaceOrderRequest> = {}): PlaceOrderRequest => ({
  idempotencyKey: 'our-key-1',
  symbol: 'AAPL',
  assetClass: AssetClass.EQUITY,
  side: 'BUY',
  orderType: OrderType.LIMIT,
  timeInForce: TimeInForce.DAY,
  quantity: dec(10),
  limitPrice: dec('185.00'),
  ...overrides,
});

describe('the three gates', () => {
  it('refuses when live trading is off for the deployment', async () => {
    await expect(broker({ allowLiveTrading: false }).placeOrder(request())).rejects.toThrow(
      /ALLOW_LIVE_TRADING is false/,
    );
  });

  it('refuses when this account is not enabled for live orders', async () => {
    await expect(broker({ liveOrdersEnabled: false }).placeOrder(request())).rejects.toThrow(
      /per-account decision/,
    );
  });

  it('refuses when the broker has not been given consent for this account', async () => {
    const fake = transport({
      getAccount: () =>
        Promise.resolve({
          account_number: 'RH-1',
          agentic_allowed: false,
          option_level: null,
          buying_power: '0',
          cash: '0',
          equity: '0',
          type: 'cash',
        }),
    });

    // The broker's own record of consent, refused here so the reason is
    // legible rather than arriving as an API error.
    await expect(broker({ transport: fake.transport }).placeOrder(request())).rejects.toThrow(
      /agentic_allowed is false/,
    );
    expect(fake.placed).toHaveLength(0);
  });

  it('reads an account even when it may not trade it', async () => {
    // Reconciliation has to be able to see an account it cannot place on.
    const account = await broker({ allowLiveTrading: false }).getAccount();
    expect(account.environment).toBe(TradingEnvironment.LIVE);
    expect(account.cash.toString()).toBe('50000');
  });
});

describe('translation', () => {
  it('sends our idempotency key as the broker’s ref_id', async () => {
    const fake = transport();
    await broker({ transport: fake.transport }).placeOrder(
      request({ idempotencyKey: 'signal:abc-123' }),
    );

    // The broker deduplicates on ref_id, so a retry cannot open a second
    // position — the same guarantee this platform makes internally.
    expect((fake.placed[0] as { ref_id: string }).ref_id).toBe('signal:abc-123');
  });

  it('maps order types to the broker’s vocabulary', async () => {
    const fake = transport();
    const live = broker({ transport: fake.transport });

    await live.placeOrder(request({ orderType: OrderType.MARKET, limitPrice: null }));
    await live.placeOrder(request({ orderType: OrderType.STOP, stopPrice: dec('180') }));

    expect((fake.placed[0] as { type: string }).type).toBe('market');
    expect((fake.placed[1] as { type: string }).type).toBe('stop_market');
  });

  it('refuses a time in force the broker does not have, rather than downgrading it', async () => {
    // An IOC that rests all day is not an IOC, and the trader would be holding
    // a position they did not agree to.
    await expect(broker().placeOrder(request({ timeInForce: TimeInForce.IOC }))).rejects.toThrow(
      /day and good-till-cancelled/,
    );
  });

  it('refuses a market order outside the regular session', async () => {
    await expect(
      broker({ session: 'extended_hours' }).placeOrder(
        request({ orderType: OrderType.MARKET, limitPrice: null }),
      ),
    ).rejects.toThrow(/only executes in the regular session/);
  });

  it('allows a limit order outside the regular session', async () => {
    const fake = transport();
    await broker({ transport: fake.transport, session: 'all_day_hours' }).placeOrder(request());

    expect((fake.placed[0] as { market_hours: string }).market_hours).toBe('all_day_hours');
  });

  it('translates every broker state, and an unknown one to UNKNOWN', () => {
    expect(translateState('filled')).toBe(OrderStatus.FILLED);
    expect(translateState('partially_filled')).toBe(OrderStatus.PARTIALLY_FILLED);
    expect(translateState('queued')).toBe(OrderStatus.ACKNOWLEDGED);
    expect(translateState('rejected')).toBe(OrderStatus.REJECTED);
    expect(translateState('voided')).toBe(OrderStatus.EXPIRED);
    // A state this build does not recognise must not become CANCELLED: that
    // could hide a live position.
    expect(translateState('some_new_state' as never)).toBe(OrderStatus.UNKNOWN);
  });

  it('marks an order it did not place as external rather than claiming it', async () => {
    const fake = transport({
      getOrders: () => Promise.resolve([order({ ref_id: null, placed_agent: 'user' })]),
    });

    const [found] = await broker({ transport: fake.transport }).getOrders();
    expect(found?.clientOrderId).toContain('external:');
  });
});

describe('fills', () => {
  it('uses per-fill detail when the broker provides it', async () => {
    const fake = transport({
      getOrder: () =>
        Promise.resolve(
          order({
            state: 'filled',
            cumulative_quantity: '10',
            average_price: '185.10',
            executions: [
              { id: 'exec-1', price: '185.00', quantity: '4', timestamp: '2026-09-11T14:31:00Z' },
              { id: 'exec-2', price: '185.17', quantity: '6', timestamp: '2026-09-11T14:32:00Z' },
            ],
          }),
        ),
    });

    const found = await broker({ transport: fake.transport }).getOrderStatus('rh-order-1');
    expect(found.executions).toHaveLength(2);
    expect(found.executions[0]?.executionId).toBe('exec-1');
  });

  it('synthesises one execution per fill delta when it does not', async () => {
    let filled = '4';
    const fake = transport({
      getOrder: () =>
        Promise.resolve(
          order({
            state: filled === '10' ? 'filled' : 'partially_filled',
            cumulative_quantity: filled,
            average_price: '185.10',
          }),
        ),
    });

    const live = broker({ transport: fake.transport });

    const first = await live.getOrderStatus('rh-order-1');
    expect(first.executions).toHaveLength(1);
    expect(first.executions[0]?.quantity.toString()).toBe('4');
    // The id says it was synthesised: a reconciliation that could not tell a
    // synthetic id from a broker one could not be interpreted.
    expect(first.executions[0]?.executionId).toContain('synthetic:');

    // Polling again with nothing new must report nothing new.
    const unchanged = await live.getOrderStatus('rh-order-1');
    expect(unchanged.executions).toHaveLength(0);

    filled = '10';
    const rest = await live.getOrderStatus('rh-order-1');
    expect(rest.executions[0]?.quantity.toString()).toBe('6');
  });

  it('gives the same synthetic id for the same fill, so ingestion is idempotent', () => {
    expect(syntheticExecutionId('order-1', '4')).toBe(syntheticExecutionId('order-1', '4'));
    expect(syntheticExecutionId('order-1', '4')).not.toBe(syntheticExecutionId('order-1', '10'));
  });
});

describe('without credentials', () => {
  it('refuses every operation rather than simulating a broker', async () => {
    const unconfigured = new UnconfiguredRobinhoodTransport();

    await expect(unconfigured.getAccount()).rejects.toThrow(/No Robinhood credentials/);
    await expect(unconfigured.placeEquityOrder()).rejects.toThrow(/will not simulate/);
    await expect(unconfigured.getPositions()).rejects.toThrow(/No Robinhood credentials/);
  });

  it('reports unhealthy rather than throwing, so the dashboard can say why', async () => {
    const live = new RobinhoodBroker({
      accountNumber: 'RH-1',
      transport: new UnconfiguredRobinhoodTransport(),
      liveOrdersEnabled: false,
      allowLiveTrading: false,
    });

    const health = await live.healthCheck();
    expect(health.ok).toBe(false);
    expect(health.detail).toContain('No Robinhood credentials');
  });

  it('says when the account is reachable but not consented', async () => {
    const fake = transport({
      getAccount: () =>
        Promise.resolve({
          account_number: 'RH-1',
          agentic_allowed: false,
          option_level: null,
          buying_power: '0',
          cash: '0',
          equity: '0',
          type: 'cash',
        }),
    });

    const health = await broker({ transport: fake.transport }).healthCheck();
    expect(health.ok).toBe(true);
    expect(health.detail).toContain('not enabled');
  });
});

describe('quotes and positions', () => {
  it('carries both clocks on a quote', async () => {
    const quote = await broker().getQuote('AAPL');

    expect(quote.sourceTimestamp.toISOString()).toBe('2026-09-11T19:55:00.000Z');
    expect(quote.receivedTimestamp).toBeInstanceOf(Date);
    expect(quote.provider).toBe('robinhood');
  });

  it('reports positions with the broker’s own market value', async () => {
    const [position] = await broker().getPositions();

    expect(position?.quantity.toString()).toBe('20');
    expect(position?.marketValue.toString()).toBe('3720');
    // 3,720 over 20 shares is 186 against a 180 basis: 120 of unrealised gain.
    expect(position?.unrealizedPnl.toString()).toBe('120');
  });

  it('does not invent a mark when the broker gives no market value', async () => {
    const fake = transport({
      getPositions: () =>
        Promise.resolve([
          { symbol: 'AAPL', quantity: '20', average_buy_price: '180', market_value: null },
        ]),
    });

    const [position] = await broker({ transport: fake.transport }).getPositions();
    // Held at cost, so the unrealised figure is zero rather than computed from
    // a price nobody quoted.
    expect(position?.unrealizedPnl.toString()).toBe('0');
  });
});

describe('what it will not do', () => {
  it('refuses an options order through the equity path', async () => {
    await expect(broker().placeOrder(request({ assetClass: AssetClass.OPTION }))).rejects.toThrow(
      /equity orders only/,
    );
  });

  it('does not serve options chains from the broker', async () => {
    await expect(broker().getOptionsChain()).rejects.toThrow(/market-data provider/);
  });
});

describe('cancellation', () => {
  it('returns the cancelled order as the broker reports it', async () => {
    const cancelled = await broker().cancelOrder('rh-order-1');
    expect(cancelled.status).toBe(OrderStatus.CANCELLED);
  });
});

/** A guard against the most dangerous possible regression. */
describe('the safety property', () => {
  it('cannot place an order with any gate closed', async () => {
    const combinations = [
      { allowLiveTrading: false, liveOrdersEnabled: false },
      { allowLiveTrading: false, liveOrdersEnabled: true },
      { allowLiveTrading: true, liveOrdersEnabled: false },
    ];

    for (const combination of combinations) {
      const fake = transport();
      await expect(
        broker({ ...combination, transport: fake.transport }).placeOrder(request()),
      ).rejects.toThrow();
      expect(fake.placed).toHaveLength(0);
    }
  });
});
