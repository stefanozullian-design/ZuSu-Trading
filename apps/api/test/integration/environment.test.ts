import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AssetClass,
  EnvironmentMismatchError,
  OrderSide,
  OrderType,
  TimeInForce,
  TradingEnvironment,
  dec,
} from '@zusu/shared';
import { BrokerRegistry } from '../../src/modules/broker/broker-registry.js';
import { AppError } from '../../src/lib/errors.js';
import { disconnectTestDb, resetDatabase, testDb } from '../helpers/db.js';
import { createPortfolio } from '../helpers/fixtures.js';

/**
 * Environment isolation (§3).
 *
 * The rule "demo or paper credentials can never place a live trade" is enforced
 * in two independent places: the broker registry in application code, and
 * triggers in the database. Both are tested here.
 */
const db = testDb();

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await disconnectTestDb();
});

describe('database-level environment guards', () => {
  it('refuses a broker account whose environment differs from its portfolio', async () => {
    const demo = await createPortfolio(db, { name: 'Demo', environment: 'DEMO' });

    await expect(
      db.brokerAccount.create({
        data: {
          portfolioId: demo.id,
          environment: 'LIVE',
          broker: 'ROBINHOOD',
          label: 'should not be possible',
        },
      }),
    ).rejects.toThrow(/environment mismatch/i);

    expect(await db.brokerAccount.count()).toBe(0);
  });

  it('refuses an order whose environment differs from its portfolio', async () => {
    const demo = await createPortfolio(db, { name: 'Demo', environment: 'DEMO' });

    await expect(
      db.order.create({
        data: {
          idempotencyKey: 'x-1',
          correlationId: '00000000-0000-4000-8000-000000000001',
          portfolioId: demo.id,
          environment: 'LIVE',
          symbol: 'AAPL',
          side: 'BUY',
          orderType: 'MARKET',
          requestedQty: '1',
        },
      }),
    ).rejects.toThrow(/environment mismatch/i);
  });

  it('refuses to route an order through a broker account in another environment', async () => {
    const demo = await createPortfolio(db, { name: 'Demo', environment: 'DEMO' });
    const paper = await createPortfolio(db, { name: 'Paper', environment: 'PAPER' });
    const paperAccount = await db.brokerAccount.create({
      data: {
        portfolioId: paper.id,
        environment: 'PAPER',
        broker: 'PAPER',
        label: 'paper account',
      },
    });

    await expect(
      db.order.create({
        data: {
          idempotencyKey: 'x-2',
          correlationId: '00000000-0000-4000-8000-000000000002',
          portfolioId: demo.id,
          brokerAccountId: paperAccount.id,
          environment: 'DEMO',
          symbol: 'AAPL',
          side: 'BUY',
          orderType: 'MARKET',
          requestedQty: '1',
        },
      }),
    ).rejects.toThrow(/broker account/i);
  });

  it('never lets a portfolio change environment', async () => {
    const demo = await createPortfolio(db, { name: 'Demo', environment: 'DEMO' });
    await expect(
      db.portfolio.update({ where: { id: demo.id }, data: { environment: 'LIVE' } }),
    ).rejects.toThrow(/may not change environment/i);

    const unchanged = await db.portfolio.findUniqueOrThrow({ where: { id: demo.id } });
    expect(unchanged.environment).toBe('DEMO');
  });

  it('allows a matching broker account', async () => {
    const demo = await createPortfolio(db, { name: 'Demo', environment: 'DEMO' });
    const account = await db.brokerAccount.create({
      data: { portfolioId: demo.id, environment: 'DEMO', broker: 'DEMO', label: 'demo' },
    });
    expect(account.environment).toBe('DEMO');
  });
});

describe('broker registry', () => {
  it('hands back a demo adapter bound to DEMO', () => {
    const registry = new BrokerRegistry({ seed: 1 });
    const adapter = registry.forPortfolio({
      id: '00000000-0000-4000-8000-00000000000a',
      environment: 'DEMO',
      initialCapital: { toString: () => '100000' } as never,
    });
    expect(adapter.environment).toBe(TradingEnvironment.DEMO);
    expect(adapter.kind).toBe('DEMO');
  });

  it('returns the same adapter instance for the same portfolio', () => {
    const registry = new BrokerRegistry({ seed: 1 });
    const portfolio = {
      id: '00000000-0000-4000-8000-00000000000b',
      environment: 'DEMO' as const,
      initialCapital: { toString: () => '100000' } as never,
    };
    expect(registry.forPortfolio(portfolio)).toBe(registry.forPortfolio(portfolio));
  });

  it('hands back a LIVE adapter that can be read but cannot place an order', async () => {
    // Since Phase 8 the refusal sits at placement rather than at construction:
    // reconciliation has to be able to *look at* an account it may not trade.
    // Reading a live account and trading it are separate permissions, and
    // conflating them meant a mismatch at the broker could never be seen.
    const registry = new BrokerRegistry({ seed: 1 });
    const adapter = registry.forPortfolio({
      id: '00000000-0000-4000-8000-00000000000c',
      environment: 'LIVE',
      initialCapital: { toString: () => '100000' } as never,
    });
    expect(adapter.environment).toBe(TradingEnvironment.LIVE);
    expect(adapter.kind).toBe('ROBINHOOD');

    await expect(
      adapter.placeOrder({
        idempotencyKey: 'never-sent',
        symbol: 'AAPL',
        assetClass: AssetClass.EQUITY,
        side: OrderSide.BUY,
        orderType: OrderType.MARKET,
        timeInForce: TimeInForce.DAY,
        quantity: dec(1),
      }),
    ).rejects.toThrow(/ALLOW_LIVE_TRADING is false/);
  });

  it('refuses PAPER until the paper broker exists, rather than faking one', () => {
    const registry = new BrokerRegistry({ seed: 1 });
    try {
      registry.forPortfolio({
        id: '00000000-0000-4000-8000-00000000000d',
        environment: 'PAPER',
        initialCapital: { toString: () => '100000' } as never,
      });
      throw new Error('expected the registry to refuse');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe('NOT_IMPLEMENTED');
    }
  });

  it('reports which environments actually have an adapter', () => {
    const registry = new BrokerRegistry({ seed: 1 });
    expect(registry.isSupported(TradingEnvironment.DEMO)).toBe(true);
    expect(registry.isSupported(TradingEnvironment.PAPER)).toBe(false);
    expect(registry.isSupported(TradingEnvironment.LIVE)).toBe(false);
  });
});

describe('EnvironmentMismatchError', () => {
  it('names both environments so the failure is diagnosable', () => {
    const error = new EnvironmentMismatchError(
      TradingEnvironment.DEMO,
      TradingEnvironment.LIVE,
      'unit test',
    );
    expect(error.message).toContain('DEMO');
    expect(error.message).toContain('LIVE');
    expect(error.message).toContain('unit test');
  });
});
