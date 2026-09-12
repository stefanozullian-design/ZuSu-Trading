import { MarketSession, dec } from '@zusu/shared';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { MarketCalendarService } from '../../src/modules/market-data/calendar.service.js';
import { MarketDataQualityService } from '../../src/modules/market-data/quality.service.js';
import type {
  MarketDataProvider,
  ProviderCalendarDay,
  ProviderCandle,
} from '../../src/modules/market-data/types.js';
import { disconnectTestDb, resetDatabase, testDb } from '../helpers/db.js';

const db = testDb();
let calendar: MarketCalendarService;

const utc = (iso: string) => new Date(iso);
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

/** A provider that reports only the calendar; nothing else is exercised here. */
function providerReturning(days: ProviderCalendarDay[]): MarketDataProvider {
  return {
    kind: 'FIXTURE',
    name: 'fixture',
    isDelayed: true,
    getQuote: () => Promise.reject(new Error('not used')),
    getQuotes: () => Promise.reject(new Error('not used')),
    getCandles: () => Promise.reject(new Error('not used')),
    getCorporateActions: () => Promise.reject(new Error('not used')),
    searchInstruments: () => Promise.reject(new Error('not used')),
    getCalendar: () => Promise.resolve(days),
    healthCheck: () => Promise.reject(new Error('not used')),
  };
}

const thanksgiving: ProviderCalendarDay[] = [
  {
    marketCode: 'XNYS',
    date: day('2026-11-26'),
    isTradingDay: false,
    preMarketOpen: null,
    regularOpen: null,
    regularClose: null,
    afterHoursClose: null,
    isEarlyClose: false,
    holidayName: 'Thanksgiving Day',
  },
  {
    marketCode: 'XNYS',
    date: day('2026-11-27'),
    isTradingDay: true,
    preMarketOpen: null,
    regularOpen: utc('2026-11-27T14:30:00Z'),
    regularClose: utc('2026-11-27T18:00:00Z'),
    afterHoursClose: null,
    isEarlyClose: true,
    holidayName: 'Thanksgiving Day',
  },
];

async function instrument(
  symbol: string,
  overrides: {
    assetClass?: 'EQUITY' | 'CRYPTO' | 'ETF';
    exchange?: string;
    isTradable?: boolean;
  } = {},
) {
  return db.instrument.create({
    data: {
      symbol,
      name: `${symbol} Inc.`,
      assetClass: overrides.assetClass ?? 'EQUITY',
      exchange: overrides.exchange ?? 'XNYS',
      isTradable: overrides.isTradable ?? true,
    },
  });
}

beforeEach(async () => {
  await resetDatabase();
  calendar = new MarketCalendarService(db);
});

afterAll(async () => {
  await disconnectTestDb();
});

describe('sync', () => {
  it('generates a week of rows without a provider', async () => {
    const summary = await calendar.sync('XNYS', day('2026-07-13'), day('2026-07-19'));

    expect(summary.daysWritten).toBe(7);
    expect(summary.holidaysApplied).toBe(0);
    expect(await db.marketCalendarDay.count()).toBe(7);

    const trading = await db.marketCalendarDay.findMany({ where: { isTradingDay: true } });
    expect(trading).toHaveLength(5);
  });

  it('applies provider holidays and early closes', async () => {
    await calendar.sync(
      'XNYS',
      day('2026-11-25'),
      day('2026-11-27'),
      providerReturning(thanksgiving),
    );

    const closed = await db.marketCalendarDay.findFirstOrThrow({
      where: { date: day('2026-11-26') },
    });
    expect(closed.isTradingDay).toBe(false);
    expect(closed.holidayName).toBe('Thanksgiving Day');

    const half = await db.marketCalendarDay.findFirstOrThrow({
      where: { date: day('2026-11-27') },
    });
    expect(half.isEarlyClose).toBe(true);
    expect(half.regularClose?.toISOString()).toBe('2026-11-27T18:00:00.000Z');
    expect(half.afterHoursClose).toBeNull();
  });

  it('is idempotent and corrects a day it learns more about later', async () => {
    await calendar.sync('XNYS', day('2026-11-26'), day('2026-11-26'));
    const before = await db.marketCalendarDay.findFirstOrThrow();
    expect(before.isTradingDay).toBe(true); // a Thursday, no holiday known yet

    await calendar.sync(
      'XNYS',
      day('2026-11-26'),
      day('2026-11-26'),
      providerReturning(thanksgiving),
    );

    expect(await db.marketCalendarDay.count()).toBe(1);
    const after = await db.marketCalendarDay.findFirstOrThrow();
    expect(after.isTradingDay).toBe(false);
    expect(after.holidayName).toBe('Thanksgiving Day');
  });

  it('rejects a market it has no definition for', async () => {
    await expect(calendar.sync('XLON', day('2026-07-13'), day('2026-07-14'))).rejects.toThrow(
      /No market definition for XLON/,
    );
  });

  it('propagates a provider failure rather than storing a holiday-free calendar', async () => {
    const failing = providerReturning([]);
    failing.getCalendar = () => Promise.reject(new Error('provider down'));

    // A silently holiday-free calendar would report Thanksgiving as a normal
    // trading day, which is worse than no calendar at all.
    await expect(
      calendar.sync('XNYS', day('2026-11-25'), day('2026-11-27'), failing),
    ).rejects.toThrow(/provider down/);
  });
});

describe('sessionFor', () => {
  beforeEach(async () => {
    await calendar.sync('XNYS', day('2026-07-13'), day('2026-07-19'));
  });

  it('reads the row for the market-local date, not the UTC one', async () => {
    // 01:00Z on Saturday is 21:00 Friday in New York, so Friday's row is the
    // one that applies. Reading Saturday's would answer a different question.
    const day = await calendar.dayFor('XNYS', utc('2026-07-18T01:00:00Z'));
    expect(day?.date.toISOString().slice(0, 10)).toBe('2026-07-17');
    expect(day?.isTradingDay).toBe(true);
  });

  it('still reports closed at 21:00 New York, after the extended session ends', async () => {
    // NYSE after-hours ends at 20:00 local, which is 00:00Z — so this instant
    // is past it even though Friday's row is the right one to read.
    expect(await calendar.sessionFor('XNYS', utc('2026-07-18T01:00:00Z'))).toBe(
      MarketSession.CLOSED,
    );
    expect(await calendar.sessionFor('XNYS', utc('2026-07-17T23:00:00Z'))).toBe(
      MarketSession.AFTER_HOURS,
    );
  });

  it('reports the regular session', async () => {
    expect(await calendar.sessionFor('XNYS', utc('2026-07-15T15:00:00Z'))).toBe(
      MarketSession.REGULAR,
    );
  });

  it('reports closed on a weekend', async () => {
    expect(await calendar.sessionFor('XNYS', utc('2026-07-18T15:00:00Z'))).toBe(
      MarketSession.CLOSED,
    );
  });

  it('reports closed for a date with no row', async () => {
    expect(await calendar.sessionFor('XNYS', utc('2027-03-01T15:00:00Z'))).toBe(
      MarketSession.CLOSED,
    );
  });
});

describe('isTradable', () => {
  beforeEach(async () => {
    await calendar.sync('XNYS', day('2026-07-13'), day('2026-07-19'));
    await calendar.sync('CRYPTO', day('2026-07-13'), day('2026-07-19'));
  });

  it('permits an equity during its regular session', async () => {
    await instrument('AAPL');
    const verdict = await calendar.isTradable('AAPL', utc('2026-07-15T15:00:00Z'));

    expect(verdict).toMatchObject({
      tradable: true,
      session: MarketSession.REGULAR,
      marketCode: 'XNYS',
      reason: null,
    });
  });

  it('permits it during pre-market too', async () => {
    await instrument('AAPL');
    const verdict = await calendar.isTradable('AAPL', utc('2026-07-15T09:00:00Z'));
    expect(verdict.tradable).toBe(true);
    expect(verdict.session).toBe(MarketSession.PRE_MARKET);
  });

  it('refuses it overnight, with the market and instant named', async () => {
    await instrument('AAPL');
    const verdict = await calendar.isTradable('AAPL', utc('2026-07-15T03:00:00Z'));

    expect(verdict.tradable).toBe(false);
    expect(verdict.session).toBe(MarketSession.CLOSED);
    expect(verdict.reason).toContain('XNYS is closed');
  });

  it('names the holiday when there is one', async () => {
    await instrument('AAPL');
    await calendar.sync(
      'XNYS',
      day('2026-11-26'),
      day('2026-11-26'),
      providerReturning(thanksgiving),
    );

    const verdict = await calendar.isTradable('AAPL', utc('2026-11-26T15:00:00Z'));
    expect(verdict.reason).toBe('XNYS is closed for Thanksgiving Day.');
  });

  it('permits crypto at 3am on a Sunday', async () => {
    await instrument('BTC-USD', { assetClass: 'CRYPTO' });
    const verdict = await calendar.isTradable('BTC-USD', utc('2026-07-19T03:00:00Z'));

    expect(verdict.tradable).toBe(true);
    expect(verdict.marketCode).toBe('CRYPTO');
  });

  it('refuses an unknown symbol', async () => {
    const verdict = await calendar.isTradable('NOPE', utc('2026-07-15T15:00:00Z'));
    expect(verdict.tradable).toBe(false);
    expect(verdict.reason).toContain('not a known instrument');
  });

  it('refuses an instrument marked untradable', async () => {
    await instrument('DELISTED', { isTradable: false });
    const verdict = await calendar.isTradable('DELISTED', utc('2026-07-15T15:00:00Z'));

    expect(verdict.tradable).toBe(false);
    expect(verdict.reason).toContain('not tradable on this platform');
  });

  it('says so plainly when no calendar is loaded', async () => {
    await instrument('AAPL');
    const verdict = await calendar.isTradable('AAPL', utc('2027-05-03T15:00:00Z'));

    expect(verdict.tradable).toBe(false);
    expect(verdict.reason).toContain('No calendar is loaded');
  });
});

describe('halts', () => {
  beforeEach(async () => {
    await calendar.sync('XNYS', day('2026-07-13'), day('2026-07-19'));
    await instrument('AAPL');
  });

  it('blocks a halted symbol during an open market, and says HALTED not CLOSED', async () => {
    await calendar.recordHalt('AAPL', { reason: 'LULD', source: 'manual' });
    const verdict = await calendar.isTradable('AAPL', utc('2026-07-15T15:00:00Z'));

    expect(verdict.tradable).toBe(false);
    // A caller that conflated the two would retry at the open.
    expect(verdict.session).toBe(MarketSession.HALTED);
    expect(verdict.reason).toContain('halted (LULD)');
  });

  it('includes the detail when one was given', async () => {
    await calendar.recordHalt('AAPL', {
      reason: 'NEWS_PENDING',
      detail: 'awaiting an announcement',
      source: 'manual',
    });
    const verdict = await calendar.isTradable('AAPL', utc('2026-07-15T15:00:00Z'));
    expect(verdict.reason).toContain('awaiting an announcement');
  });

  it('treats a second halt on the same symbol as a no-op', async () => {
    await calendar.recordHalt('AAPL', { reason: 'LULD', source: 'manual' });
    await calendar.recordHalt('AAPL', { reason: 'REGULATORY', source: 'manual' });

    // Two open rows would mean releasing one still read as halted.
    expect(await db.tradingHalt.count({ where: { releasedAt: null } })).toBe(1);
    const halt = await db.tradingHalt.findFirstOrThrow();
    expect(halt.reason).toBe('LULD');
  });

  it('permits trading again once released', async () => {
    await calendar.recordHalt('AAPL', { reason: 'LULD', source: 'manual' });
    await calendar.releaseHalt('AAPL');

    const verdict = await calendar.isTradable('AAPL', utc('2026-07-15T15:00:00Z'));
    expect(verdict.tradable).toBe(true);
  });

  it('keeps the released row as history', async () => {
    await calendar.recordHalt('AAPL', { reason: 'LULD', source: 'manual' });
    await calendar.releaseHalt('AAPL');

    const halt = await db.tradingHalt.findFirstOrThrow();
    expect(halt.releasedAt).not.toBeNull();
    expect(await db.tradingHalt.count()).toBe(1);
  });

  it('allows a fresh halt after a release', async () => {
    await calendar.recordHalt('AAPL', { reason: 'LULD', source: 'manual' });
    await calendar.releaseHalt('AAPL');
    await calendar.recordHalt('AAPL', { reason: 'NEWS_PENDING', source: 'manual' });

    expect(await db.tradingHalt.count()).toBe(2);
    expect(await calendar.openHalts()).toHaveLength(1);
  });

  it('refuses to halt an unknown symbol', async () => {
    await expect(calendar.recordHalt('NOPE', { reason: 'LULD', source: 'manual' })).rejects.toThrow(
      /No instrument record exists/,
    );
  });

  it('lists open halts only', async () => {
    await instrument('MSFT');
    await calendar.recordHalt('AAPL', { reason: 'LULD', source: 'manual' });
    await calendar.recordHalt('MSFT', { reason: 'NEWS_PENDING', source: 'manual' });
    await calendar.releaseHalt('AAPL');

    const open = await calendar.openHalts();
    expect(open.map((h) => h.symbol)).toEqual(['MSFT']);
  });
});

describe('gap detection', () => {
  beforeEach(async () => {
    await calendar.sync('XNYS', day('2026-07-13'), day('2026-07-19'));
  });

  it('calls an overnight break a session gap', async () => {
    const gap = await calendar.isSessionGap(
      'XNYS',
      utc('2026-07-15T19:59:00Z'),
      utc('2026-07-16T13:30:00Z'),
      '1m',
    );
    expect(gap).toBe(true);
  });

  it('calls a weekend a session gap', async () => {
    const gap = await calendar.isSessionGap(
      'XNYS',
      utc('2026-07-17T19:59:00Z'),
      utc('2026-07-20T13:30:00Z'),
      '1m',
    );
    expect(gap).toBe(true);
  });

  it('does not excuse a hole inside the regular session', async () => {
    const gap = await calendar.isSessionGap(
      'XNYS',
      utc('2026-07-15T15:00:00Z'),
      utc('2026-07-15T15:10:00Z'),
      '1m',
    );
    expect(gap).toBe(false);
  });

  it('refuses to claim a gap when no calendar is loaded', async () => {
    const gap = await calendar.isSessionGap(
      'XNYS',
      utc('2027-05-03T15:00:00Z'),
      utc('2027-05-03T15:10:00Z'),
      '1m',
    );
    // Cannot assert the market was shut, so the finding stands.
    expect(gap).toBe(false);
  });

  it('scales with the timeframe', async () => {
    // Five minutes of open market is a gap for a 15m bar but not for a 1m bar.
    const from = utc('2026-07-15T15:00:00Z');
    const to = utc('2026-07-15T15:05:00Z');
    expect(await calendar.isSessionGap('XNYS', from, to, '1m')).toBe(false);
    expect(await calendar.isSessionGap('XNYS', from, to, '15m')).toBe(true);
  });
});

describe('gapResolverFor', () => {
  beforeEach(async () => {
    await calendar.sync('XNYS', day('2026-07-13'), day('2026-07-19'));
  });

  it('returns a synchronous predicate that agrees with the async version', async () => {
    const resolver = await calendar.gapResolverFor(
      'XNYS',
      '1m',
      day('2026-07-13'),
      day('2026-07-19'),
    );

    expect(resolver(utc('2026-07-15T19:59:00Z'), utc('2026-07-16T13:30:00Z'))).toBe(true);
    expect(resolver(utc('2026-07-15T15:00:00Z'), utc('2026-07-15T15:10:00Z'))).toBe(false);
  });

  it('reports no session gap when the range has no rows', async () => {
    const resolver = await calendar.gapResolverFor(
      'XNYS',
      '1m',
      day('2027-05-01'),
      day('2027-05-07'),
    );
    expect(resolver(utc('2027-05-03T15:00:00Z'), utc('2027-05-03T16:00:00Z'))).toBe(false);
  });
});

describe('closing the quality layer gap-detection limitation', () => {
  beforeEach(async () => {
    await calendar.sync('XNYS', day('2026-07-13'), day('2026-07-19'));
    await db.instrument.create({ data: { symbol: 'AAPL', name: 'Apple', exchange: 'XNYS' } });
  });

  const bar = (openTime: string): ProviderCandle => ({
    symbol: 'AAPL',
    timeframe: '1m',
    openTime: utc(openTime),
    closeTime: new Date(utc(openTime).getTime() + 60_000),
    open: dec('100'),
    high: dec('101'),
    low: dec('99'),
    close: dec('100.5'),
    volume: dec('5000'),
    vwap: dec('100.2'),
    tradeCount: 10,
    isAdjusted: true,
  });

  it('no longer treats an overnight break as a missing bar', async () => {
    const quality = new MarketDataQualityService(db);
    const isSessionGap = await calendar.gapResolverFor(
      'XNYS',
      '1m',
      day('2026-07-13'),
      day('2026-07-19'),
    );

    const result = await quality.ingestCandles(
      [bar('2026-07-15T19:59:00Z'), bar('2026-07-16T13:30:00Z')],
      { provider: 'massive', isSessionGap },
    );

    expect(result.accepted).toBe(true);
    expect(result.findings).toEqual([]);
    expect(result.stored).toBe(2);
  });

  it('still reports a hole inside the regular session', async () => {
    const quality = new MarketDataQualityService(db);
    const isSessionGap = await calendar.gapResolverFor(
      'XNYS',
      '1m',
      day('2026-07-13'),
      day('2026-07-19'),
    );

    const result = await quality.ingestCandles(
      [bar('2026-07-15T15:00:00Z'), bar('2026-07-15T15:10:00Z')],
      { provider: 'massive', isSessionGap },
    );

    expect(result.accepted).toBe(false);
    expect(result.findings.map((f) => f.issue)).toEqual(['MISSING_CANDLE']);
  });

  it('reports the overnight break as a gap when no resolver is supplied', async () => {
    const quality = new MarketDataQualityService(db);
    // The documented pre-calendar behaviour: a cross-day break is not raised
    // at all, because it cannot be distinguished from a dropped bar.
    const result = await quality.ingestCandles(
      [bar('2026-07-15T19:59:00Z'), bar('2026-07-16T13:30:00Z')],
      { provider: 'massive' },
    );
    expect(result.findings).toEqual([]);
  });
});
