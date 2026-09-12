import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { DemoFeed } from '../../src/modules/market-data/demo-feed.js';
import { MarketCalendarService } from '../../src/modules/market-data/calendar.service.js';
import { MarketDataQualityService } from '../../src/modules/market-data/quality.service.js';
import { disconnectTestDb, resetDatabase, testDb } from '../helpers/db.js';

const db = testDb();
let feed: DemoFeed;
let calendar: MarketCalendarService;

// A Wednesday-to-Friday window well inside a trading week.
const FROM = new Date('2026-07-15T00:00:00.000Z');
const TO = new Date('2026-07-18T00:00:00.000Z');

beforeEach(async () => {
  await resetDatabase();
  const quality = new MarketDataQualityService(db);
  calendar = new MarketCalendarService(db);
  feed = new DemoFeed(db, quality, calendar, { seed: 20260101 });

  await calendar.sync('XNYS', FROM, TO);
  await feed.ensureInstruments();
});

afterAll(async () => {
  await disconnectTestDb();
});

describe('demo feed — bar grid', () => {
  it('places 5m bars on a fixed grid from the epoch', async () => {
    await feed.backfill('AAPL', '5m', FROM, TO);

    const bars = await db.marketDataCandle.findMany({
      where: { symbol: 'AAPL', timeframe: '5m' },
      orderBy: { openTime: 'asc' },
      take: 5,
    });

    expect(bars.length).toBeGreaterThan(0);
    for (const bar of bars) {
      // Anchoring to `from` instead would put bars at arbitrary offsets.
      expect(bar.openTime.getTime() % 300_000, bar.openTime.toISOString()).toBe(0);
    }
  });

  it('is idempotent — a second run writes no new bars', async () => {
    await feed.backfill('AAPL', '5m', FROM, TO);
    const first = await db.marketDataCandle.count();

    // Re-running over a window offset by a few minutes must still land on the
    // same grid, so the upsert updates rather than inserting a parallel set.
    await feed.backfill('AAPL', '5m', new Date(FROM.getTime() + 137_000), TO);
    expect(await db.marketDataCandle.count()).toBe(first);
  });
});

describe('demo feed — session awareness', () => {
  it('writes intraday bars only while the market was open', async () => {
    await feed.backfill('AAPL', '5m', FROM, TO);

    const bars = await db.marketDataCandle.findMany({
      where: { symbol: 'AAPL', timeframe: '5m' },
      select: { openTime: true },
    });

    for (const bar of bars) {
      const session = await calendar.sessionFor('XNYS', bar.openTime);
      expect(session, bar.openTime.toISOString()).toBe('REGULAR');
    }
  });

  it('writes one bar per regular session for a 5m timeframe', async () => {
    await feed.backfill('AAPL', '5m', FROM, TO);
    // 6.5 hours of regular session is 78 five-minute bars per trading day, and
    // the window covers three weekdays.
    expect(await db.marketDataCandle.count()).toBe(78 * 3);
  });

  it('writes daily bars, whose open instant is midnight', async () => {
    await feed.backfill('AAPL', '1d', FROM, TO);

    const bars = await db.marketDataCandle.findMany({
      where: { symbol: 'AAPL', timeframe: '1d' },
      orderBy: { openTime: 'asc' },
    });

    // A daily bar opens at midnight, when no market is open. Gating it on the
    // session at that instant — as an intraday bar is gated — would discard
    // every daily bar, which is exactly the bug this guards.
    expect(bars).toHaveLength(3);
    for (const bar of bars) {
      expect(bar.openTime.toISOString().slice(11)).toBe('00:00:00.000Z');
    }
  });

  it('skips a weekend for daily bars', async () => {
    const overWeekend = new Date('2026-07-20T00:00:00.000Z'); // the Monday after
    await calendar.sync('XNYS', FROM, overWeekend);
    await feed.backfill('AAPL', '1d', FROM, overWeekend);

    const dates = (
      await db.marketDataCandle.findMany({
        where: { symbol: 'AAPL', timeframe: '1d' },
        orderBy: { openTime: 'asc' },
        select: { openTime: true },
      })
    ).map((bar) => bar.openTime.toISOString().slice(0, 10));

    expect(dates).toEqual(['2026-07-15', '2026-07-16', '2026-07-17']);
  });
});

describe('demo feed — provenance and quality', () => {
  it('tags every row as simulated', async () => {
    await feed.backfill('AAPL', '5m', FROM, TO);
    const providers = await db.marketDataCandle.findMany({
      distinct: ['provider'],
      select: { provider: true },
    });
    // Nothing written here may be mistaken for a real feed.
    expect(providers.map((p) => p.provider)).toEqual(['demo-simulator']);
  });

  it('produces bars the quality layer accepts', async () => {
    const summary = await feed.backfill('AAPL', '5m', FROM, TO);

    expect(summary.stored).toBe(summary.generated);
    expect(summary.rejected).toBe(0);
    expect(await db.marketDataQualityEvent.count({ where: { blocking: true } })).toBe(0);
  });

  it('produces bars with a real range, so ATR is not zero', async () => {
    await feed.backfill('AAPL', '5m', FROM, TO);
    const bar = await db.marketDataCandle.findFirstOrThrow({ where: { symbol: 'AAPL' } });
    expect(Number(bar.high) - Number(bar.low)).toBeGreaterThan(0);
  });

  it('is deterministic for a given seed', async () => {
    await feed.backfill('AAPL', '5m', FROM, TO);
    const first = await db.marketDataCandle.findFirstOrThrow({
      where: { symbol: 'AAPL' },
      orderBy: { openTime: 'asc' },
    });

    await db.marketDataCandle.deleteMany({});
    const again = new DemoFeed(db, new MarketDataQualityService(db), calendar, {
      seed: 20260101,
    });
    await again.backfill('AAPL', '5m', FROM, TO);
    const second = await db.marketDataCandle.findFirstOrThrow({
      where: { symbol: 'AAPL' },
      orderBy: { openTime: 'asc' },
    });

    expect(second.close.toString()).toBe(first.close.toString());
  });
});
