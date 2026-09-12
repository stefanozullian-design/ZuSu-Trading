import { dec } from '@zusu/shared';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { MarketDataQualityService } from '../../src/modules/market-data/quality.service.js';
import { DataQualityIssue } from '../../src/modules/market-data/quality.js';
import type { ProviderCandle, ProviderQuote } from '../../src/modules/market-data/types.js';
import { MarketCalendarService } from '../../src/modules/market-data/calendar.service.js';
import { TradingGate } from '../../src/modules/risk/trading-gate.js';
import { BrokerRegistry } from '../../src/modules/broker/broker-registry.js';
import { HealthService } from '../../src/modules/health/health.service.js';
import { disconnectTestDb, resetDatabase, testDb } from '../helpers/db.js';
import { createPortfolio } from '../helpers/fixtures.js';

const db = testDb();
let quality: MarketDataQualityService;

const SOURCE = new Date('2026-09-11T14:30:00.000Z');

function quote(overrides: Partial<ProviderQuote> = {}): ProviderQuote {
  return {
    symbol: 'AAPL',
    provider: 'massive',
    price: dec('100'),
    bid: dec('99.99'),
    ask: dec('100.01'),
    bidSize: dec('200'),
    askSize: dec('300'),
    volume: dec('1000000'),
    sourceTimestamp: SOURCE,
    receivedTimestamp: new Date(SOURCE.getTime() + 100),
    marketSession: null,
    ...overrides,
  };
}

function candle(openTime: string, overrides: Partial<ProviderCandle> = {}): ProviderCandle {
  const open = new Date(openTime);
  return {
    symbol: 'AAPL',
    timeframe: '1m',
    openTime: open,
    closeTime: new Date(open.getTime() + 60_000),
    open: dec('100'),
    high: dec('101'),
    low: dec('99'),
    close: dec('100.5'),
    volume: dec('5000'),
    vwap: dec('100.2'),
    tradeCount: 42,
    isAdjusted: true,
    ...overrides,
  };
}

async function seedInstrument(symbol = 'AAPL') {
  return db.instrument.create({ data: { symbol, name: `${symbol} Inc.` } });
}

beforeEach(async () => {
  await resetDatabase();
  quality = new MarketDataQualityService(db);
});

afterAll(async () => {
  await disconnectTestDb();
});

describe('quote ingestion', () => {
  it('stores a clean quote and records no event', async () => {
    await seedInstrument();
    const result = await quality.ingestQuote(quote());

    expect(result.accepted).toBe(true);
    expect(result.stored).toBe(1);
    expect(await db.marketDataQualityEvent.count()).toBe(0);

    const stored = await db.marketDataQuote.findFirstOrThrow();
    expect(stored.price.toString()).toBe('100');
    expect(stored.provider).toBe('massive');
    expect(stored.isStale).toBe(false);
  });

  it('refuses a stale quote and stores nothing', async () => {
    await seedInstrument();
    const result = await quality.ingestQuote(
      quote({ receivedTimestamp: new Date(SOURCE.getTime() + 60_000) }),
    );

    expect(result.accepted).toBe(false);
    expect(result.stored).toBe(0);
    // A price the platform has judged unusable must not be anywhere something
    // could read it, not even flagged as stale.
    expect(await db.marketDataQuote.count()).toBe(0);

    const event = await db.marketDataQualityEvent.findFirstOrThrow();
    expect(event.issue).toBe(DataQualityIssue.STALE_QUOTE);
    expect(event.blocking).toBe(true);
    expect(event.resolvedAt).toBeNull();
    expect(event.symbol).toBe('AAPL');
  });

  it('attaches the event to the instrument when one exists', async () => {
    const instrument = await seedInstrument();
    await quality.ingestQuote(quote({ bid: dec('101'), ask: dec('100') }));

    const event = await db.marketDataQualityEvent.findFirstOrThrow();
    expect(event.instrumentId).toBe(instrument.id);
  });

  it('reports an unknown symbol rather than silently dropping the data', async () => {
    await expect(quality.ingestQuote(quote({ symbol: 'NOPE' }))).rejects.toThrow(
      /No instrument record exists for NOPE/,
    );
    expect(await db.marketDataQuote.count()).toBe(0);
  });

  it('detects a jump against the previous accepted price', async () => {
    await seedInstrument();
    await quality.ingestQuote(quote());
    const jumped = await quality.ingestQuote(quote({ price: dec('500') }));

    expect(jumped.accepted).toBe(false);
    const events = await db.marketDataQualityEvent.findMany();
    expect(events.map((e) => e.issue)).toContain(DataQualityIssue.ABNORMAL_JUMP);
  });

  it('does not update the reference price from a rejected quote', async () => {
    await seedInstrument();
    await quality.ingestQuote(quote());
    await quality.ingestQuote(quote({ price: dec('500') })); // rejected

    // If the rejected 500 had become the reference, 100 would now look like a
    // crash and the feed would never recover.
    const recovered = await quality.ingestQuote(quote({ price: dec('101') }));
    expect(recovered.accepted).toBe(true);
  });

  it('clears the reference price on demand', async () => {
    await seedInstrument();
    await quality.ingestQuote(quote());
    quality.clearReferencePrices();

    // Without a reference an overnight move cannot be called an abnormal jump.
    const next = await quality.ingestQuote(quote({ price: dec('500') }));
    expect(next.accepted).toBe(true);
  });

  it('resolves an open event once the feed recovers', async () => {
    await seedInstrument();
    await quality.ingestQuote(quote({ receivedTimestamp: new Date(SOURCE.getTime() + 60_000) }));
    expect((await quality.verdict()).ok).toBe(false);

    await quality.ingestQuote(quote());

    const verdict = await quality.verdict();
    expect(verdict.ok).toBe(true);
    const event = await db.marketDataQualityEvent.findFirstOrThrow();
    expect(event.blocking).toBe(false);
    expect(event.resolvedAt).not.toBeNull();
  });

  it('keeps an event open while the same fault persists', async () => {
    await seedInstrument();
    const stale = quote({ receivedTimestamp: new Date(SOURCE.getTime() + 60_000) });
    await quality.ingestQuote(stale);
    await quality.ingestQuote(stale);

    // Data that is still stale must not be marked healthy for being re-checked.
    const open = await db.marketDataQualityEvent.findMany({
      where: { blocking: true, resolvedAt: null },
    });
    expect(open).toHaveLength(2);
    expect((await quality.verdict()).ok).toBe(false);
  });
});

describe('candle ingestion', () => {
  it('stores a clean series', async () => {
    await seedInstrument();
    const result = await quality.ingestCandles(
      [candle('2026-09-11T14:30:00Z'), candle('2026-09-11T14:31:00Z')],
      { provider: 'massive' },
    );

    expect(result.accepted).toBe(true);
    expect(result.stored).toBe(2);
    expect(await db.marketDataCandle.count()).toBe(2);
  });

  it('stores the good bars and rejects the batch when one is impossible', async () => {
    await seedInstrument();
    const result = await quality.ingestCandles(
      [
        candle('2026-09-11T14:30:00Z'),
        candle('2026-09-11T14:31:00Z', { high: dec('98'), low: dec('99') }),
        candle('2026-09-11T14:32:00Z'),
      ],
      { provider: 'massive' },
    );

    // Partially salvageable: the caller is told it did not get what it asked
    // for, but two valid bars are not thrown away.
    expect(result.accepted).toBe(false);
    expect(result.stored).toBe(2);
    expect(await db.marketDataCandle.count()).toBe(2);
  });

  it('is idempotent across a re-fetch of the same range', async () => {
    await seedInstrument();
    const series = [candle('2026-09-11T14:30:00Z'), candle('2026-09-11T14:31:00Z')];
    await quality.ingestCandles(series, { provider: 'massive' });
    await quality.ingestCandles(series, { provider: 'massive' });

    expect(await db.marketDataCandle.count()).toBe(2);
  });

  it('updates a bar the provider has revised', async () => {
    await seedInstrument();
    await quality.ingestCandles([candle('2026-09-11T14:30:00Z')], { provider: 'massive' });
    await quality.ingestCandles([candle('2026-09-11T14:30:00Z', { close: dec('100.9') })], {
      provider: 'massive',
    });

    const stored = await db.marketDataCandle.findFirstOrThrow();
    expect(stored.close.toString()).toBe('100.9');
    expect(await db.marketDataCandle.count()).toBe(1);
  });

  it('accepts an empty series without touching the database', async () => {
    const result = await quality.ingestCandles([], { provider: 'massive' });
    expect(result).toEqual({ findings: [], stored: 0, accepted: true });
    expect(await db.marketDataQualityEvent.count()).toBe(0);
  });

  it('records a same-day hole as blocking', async () => {
    await seedInstrument();
    const result = await quality.ingestCandles(
      [candle('2026-09-11T14:30:00Z'), candle('2026-09-11T14:35:00Z')],
      { provider: 'massive' },
    );

    expect(result.accepted).toBe(false);
    const event = await db.marketDataQualityEvent.findFirstOrThrow();
    expect(event.issue).toBe(DataQualityIssue.MISSING_CANDLE);
    expect(event.blocking).toBe(true);
  });
});

describe('provider outages', () => {
  it('records an outage as a feed-wide blocking event', async () => {
    await quality.recordOutage('massive', 'connection refused');

    const verdict = await quality.verdict();
    expect(verdict.ok).toBe(false);
    expect(verdict.feedWide).toHaveLength(1);
    expect(verdict.bySymbol).toHaveLength(0);
    expect(verdict.feedWide[0]?.issue).toBe(DataQualityIssue.PROVIDER_OUTAGE);
  });

  it('clears the outage when the provider answers again', async () => {
    await quality.recordOutage('massive', 'connection refused');
    await quality.resolveOutage('massive');

    expect((await quality.verdict()).ok).toBe(true);
  });

  it('is not cleared by a symbol recovering', async () => {
    await seedInstrument();
    await quality.recordOutage('massive', 'connection refused');
    await quality.ingestQuote(quote());

    // One good symbol says nothing about a dead provider.
    expect((await quality.verdict()).ok).toBe(false);
  });
});

describe('verdict shape', () => {
  it('separates feed-wide faults from per-symbol faults', async () => {
    await seedInstrument();
    await seedInstrument('MSFT');
    await quality.recordOutage('massive', 'down');
    await quality.ingestQuote(quote({ bid: dec('101'), ask: dec('100') }));
    await quality.ingestQuote(quote({ symbol: 'MSFT', price: dec('-1') }));

    const verdict = await quality.verdict();
    expect(verdict.feedWide).toHaveLength(1);
    expect(verdict.bySymbol.map((e) => e.symbol).sort()).toEqual(['AAPL', 'MSFT']);
  });

  it('scopes verdictForSymbol to one symbol', async () => {
    await seedInstrument();
    await seedInstrument('MSFT');
    await quality.ingestQuote(quote({ bid: dec('101'), ask: dec('100') }));

    expect(await quality.verdictForSymbol('AAPL')).toHaveLength(1);
    expect(await quality.verdictForSymbol('MSFT')).toHaveLength(0);
  });
});

describe('trading gate integration', () => {
  // A fixed instant inside a regular NYSE session. The gate takes its clock as
  // an input precisely so these assertions do not depend on when they run.
  const DURING_SESSION = new Date('2026-07-15T15:00:00.000Z');
  let calendar: MarketCalendarService;

  function gateFor() {
    const brokers = new BrokerRegistry();
    const health = new HealthService(db);
    return new TradingGate(db, brokers, health, quality, calendar);
  }

  beforeEach(async () => {
    calendar = new MarketCalendarService(db);
    await calendar.sync(
      'XNYS',
      new Date('2026-07-13T00:00:00.000Z'),
      new Date('2026-07-19T00:00:00.000Z'),
    );
  });

  it('blocks a PAPER portfolio when the feed is down', async () => {
    const portfolio = await createPortfolio(db, { name: 'Paper', environment: 'PAPER' });
    await quality.recordOutage('massive', 'connection refused');

    const decision = await gateFor().evaluate(portfolio);
    const blocker = decision.blockers.find((b) => b.code.startsWith('MARKET_DATA_'));
    expect(blocker?.severity).toBe('BLOCKING');
    expect(blocker?.message).toContain('connection refused');
    expect(decision.allowed).toBe(false);
  });

  it('does not block a DEMO portfolio, which the simulator prices', async () => {
    const portfolio = await createPortfolio(db, { name: 'Demo', environment: 'DEMO' });
    await quality.recordOutage('massive', 'connection refused');

    const decision = await gateFor().evaluate(portfolio);
    expect(decision.blockers.some((b) => b.code.startsWith('MARKET_DATA_'))).toBe(false);
  });

  it('warns but does not block when only one symbol is bad', async () => {
    await seedInstrument();
    const portfolio = await createPortfolio(db, { name: 'Paper', environment: 'PAPER' });
    await quality.ingestQuote(quote({ bid: dec('101'), ask: dec('100') }));

    const decision = await gateFor().evaluate(portfolio);
    const warning = decision.blockers.find((b) => b.code === 'MARKET_DATA_SYMBOL_ISSUES');
    // One impossible symbol must not halt a whole portfolio.
    expect(warning?.severity).toBe('WARNING');
  });

  it('blocks that symbol when the order names it', async () => {
    await seedInstrument();
    const portfolio = await createPortfolio(db, { name: 'Paper', environment: 'PAPER' });
    await quality.ingestQuote(quote({ bid: dec('101'), ask: dec('100') }));

    const decision = await gateFor().evaluate(portfolio, { symbol: 'AAPL', at: DURING_SESSION });
    const blocker = decision.blockers.find((b) => b.code.startsWith('MARKET_DATA_IMPOSSIBLE'));
    expect(blocker?.severity).toBe('BLOCKING');
    expect(blocker?.message).toContain('AAPL');
    expect(decision.allowed).toBe(false);
  });

  it('permits an unaffected symbol on the same portfolio', async () => {
    await seedInstrument();
    await seedInstrument('MSFT');
    const portfolio = await createPortfolio(db, { name: 'Paper', environment: 'PAPER' });
    await quality.ingestQuote(quote({ bid: dec('101'), ask: dec('100') }));

    const decision = await gateFor().evaluate(portfolio, { symbol: 'MSFT', at: DURING_SESSION });
    expect(decision.blockers.some((b) => b.code.startsWith('MARKET_DATA_IMPOSSIBLE'))).toBe(false);
  });

  it('stops blocking once the fault is resolved', async () => {
    await seedInstrument();
    const portfolio = await createPortfolio(db, { name: 'Paper', environment: 'PAPER' });
    await quality.ingestQuote(quote({ bid: dec('101'), ask: dec('100') }));
    await quality.ingestQuote(quote());

    const decision = await gateFor().evaluate(portfolio, { symbol: 'AAPL', at: DURING_SESSION });
    expect(decision.blockers.some((b) => b.code.startsWith('MARKET_DATA_'))).toBe(false);
  });
});

/**
 * The market being shut (the DEMO exemption, removed).
 *
 * DEMO used to skip this check on the grounds that the simulator owned its own
 * session logic. It does not: the simulator and the calendar both derive their
 * session from the same `sessionAt` over the same NYSE definition. What the
 * exemption actually produced was two screens disagreeing — the market page
 * saying the symbol could not be traded while the trading page took the
 * approval and the venue then declined to fill it.
 */
describe('a closed market blocks every environment', () => {
  const OVERNIGHT = new Date('2026-07-15T03:00:00.000Z');
  const DURING_SESSION = new Date('2026-07-15T15:00:00.000Z');
  let calendar: MarketCalendarService;

  function gateFor() {
    return new TradingGate(db, new BrokerRegistry(), new HealthService(db), quality, calendar);
  }

  beforeEach(async () => {
    calendar = new MarketCalendarService(db);
    await calendar.sync(
      'XNYS',
      new Date('2026-07-13T00:00:00.000Z'),
      new Date('2026-07-19T00:00:00.000Z'),
    );
    await seedInstrument();
  });

  it('blocks a DEMO portfolio overnight, and names when it reopens', async () => {
    const portfolio = await createPortfolio(db, { name: 'Demo', environment: 'DEMO' });

    const decision = await gateFor().evaluate(portfolio, { symbol: 'AAPL', at: OVERNIGHT });
    const blocker = decision.blockers.find((b) => b.code === 'MARKET_CLOSED');

    expect(decision.allowed).toBe(false);
    expect(blocker?.message).toContain('XNYS is closed');
    // Actionable, not just a refusal.
    expect(blocker?.message).toContain('opens next at 2026-07-15T13:30:00.000Z');
  });

  it('permits the same DEMO portfolio inside the session', async () => {
    const portfolio = await createPortfolio(db, { name: 'Demo', environment: 'DEMO' });
    const decision = await gateFor().evaluate(portfolio, { symbol: 'AAPL', at: DURING_SESSION });
    expect(decision.blockers.some((b) => b.code === 'MARKET_CLOSED')).toBe(false);
  });

  it('answers the portfolio-level question too, with no symbol named', async () => {
    // This is the call the dashboard makes on every refresh. It used to skip
    // the session entirely and report "trading permitted" on a Saturday.
    const portfolio = await createPortfolio(db, { name: 'Demo', environment: 'DEMO' });

    const closed = await gateFor().evaluate(portfolio, { at: OVERNIGHT });
    expect(closed.blockers.some((b) => b.code === 'MARKET_CLOSED')).toBe(true);

    const open = await gateFor().evaluate(portfolio, { at: DURING_SESSION });
    expect(open.blockers.some((b) => b.code === 'MARKET_CLOSED')).toBe(false);
  });

  it('distinguishes a halt from a closed market', async () => {
    const portfolio = await createPortfolio(db, { name: 'Demo', environment: 'DEMO' });
    await calendar.recordHalt('AAPL', { reason: 'NEWS_PENDING', source: 'test' });

    const decision = await gateFor().evaluate(portfolio, { symbol: 'AAPL', at: DURING_SESSION });
    // A caller that conflated the two would retry at the open and be wrong.
    expect(decision.blockers.some((b) => b.code === 'SYMBOL_HALTED')).toBe(true);
    expect(decision.blockers.some((b) => b.code === 'MARKET_CLOSED')).toBe(false);
  });
});
