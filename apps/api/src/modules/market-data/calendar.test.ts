import { AssetClass, MarketSession } from '@zusu/shared';
import { describe, expect, it } from 'vitest';
import {
  MARKET_DEFINITIONS,
  buildCalendarDay,
  eachUtcMidnight,
  isTradableSession,
  marketCodeFor,
  sessionAt,
  tradableMsBetween,
  type CalendarDay,
} from './calendar.js';
import {
  isoWeekday,
  parseWallClock,
  zoneOffsetMs,
  zonedDateParts,
  zonedTimeToUtc,
} from './time-zone.js';

const NYSE = MARKET_DEFINITIONS.XNYS as (typeof MARKET_DEFINITIONS)['XNYS'];
const CRYPTO = MARKET_DEFINITIONS.CRYPTO as (typeof MARKET_DEFINITIONS)['CRYPTO'];

const utc = (iso: string) => new Date(iso);
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

describe('zonedTimeToUtc — daylight saving', () => {
  it('resolves 09:30 New York to 13:30Z in summer', () => {
    // EDT, UTC-4.
    expect(zonedTimeToUtc(2026, 7, 15, 9, 30, 'America/New_York').toISOString()).toBe(
      '2026-07-15T13:30:00.000Z',
    );
  });

  it('resolves 09:30 New York to 14:30Z in winter', () => {
    // EST, UTC-5. A fixed offset would put this an hour out for half the year.
    expect(zonedTimeToUtc(2026, 1, 15, 9, 30, 'America/New_York').toISOString()).toBe(
      '2026-01-15T14:30:00.000Z',
    );
  });

  it('handles the day the clocks go forward', () => {
    // US DST began 2026-03-08. The session opens in EDT that morning.
    expect(zonedTimeToUtc(2026, 3, 9, 9, 30, 'America/New_York').toISOString()).toBe(
      '2026-03-09T13:30:00.000Z',
    );
  });

  it('handles the day the clocks go back', () => {
    // DST ended 2026-11-01, so the Monday after is EST.
    expect(zonedTimeToUtc(2026, 11, 2, 9, 30, 'America/New_York').toISOString()).toBe(
      '2026-11-02T14:30:00.000Z',
    );
  });

  it('is the identity for UTC', () => {
    expect(zonedTimeToUtc(2026, 6, 1, 12, 0, 'UTC').toISOString()).toBe('2026-06-01T12:00:00.000Z');
  });

  it('handles a zone ahead of Greenwich', () => {
    expect(zonedTimeToUtc(2026, 6, 1, 9, 0, 'Asia/Tokyo').toISOString()).toBe(
      '2026-06-01T00:00:00.000Z',
    );
  });

  it('produces a valid date even for a non-existent local time', () => {
    // 02:30 on a spring-forward morning never happens locally.
    const result = zonedTimeToUtc(2026, 3, 8, 2, 30, 'America/New_York');
    expect(Number.isNaN(result.getTime())).toBe(false);
  });
});

describe('zoneOffsetMs', () => {
  it('reports the summer and winter offsets for New York', () => {
    expect(zoneOffsetMs(utc('2026-07-15T12:00:00Z'), 'America/New_York')).toBe(-4 * 3_600_000);
    expect(zoneOffsetMs(utc('2026-01-15T12:00:00Z'), 'America/New_York')).toBe(-5 * 3_600_000);
  });

  it('reports zero for UTC', () => {
    expect(zoneOffsetMs(utc('2026-07-15T12:00:00Z'), 'UTC')).toBe(0);
  });
});

describe('zonedDateParts', () => {
  it('reports the market-local date, not the UTC one', () => {
    // 01:00Z on a Saturday is still Friday evening in New York.
    expect(zonedDateParts(utc('2026-09-12T01:00:00Z'), 'America/New_York')).toEqual({
      year: 2026,
      month: 9,
      day: 11,
    });
  });
});

describe('parseWallClock', () => {
  it('parses a valid time', () => {
    expect(parseWallClock('09:30')).toEqual({ hour: 9, minute: 30 });
    expect(parseWallClock('00:00')).toEqual({ hour: 0, minute: 0 });
    expect(parseWallClock('23:59')).toEqual({ hour: 23, minute: 59 });
  });

  it('rejects nonsense', () => {
    for (const bad of ['24:00', '9:30', '09:60', '', 'noon', '09-30']) {
      expect(() => parseWallClock(bad)).toThrow(/Invalid wall-clock time/);
    }
  });
});

describe('isoWeekday', () => {
  it('numbers Monday 1 through Sunday 7', () => {
    expect(isoWeekday(day('2026-09-07'))).toBe(1); // Monday
    expect(isoWeekday(day('2026-09-12'))).toBe(6); // Saturday
    expect(isoWeekday(day('2026-09-13'))).toBe(7); // Sunday
  });
});

describe('buildCalendarDay — ordinary days', () => {
  it('generates summer boundaries in UTC', () => {
    const built = buildCalendarDay(NYSE, day('2026-07-15'));

    expect(built.isTradingDay).toBe(true);
    expect(built.preMarketOpen?.toISOString()).toBe('2026-07-15T08:00:00.000Z');
    expect(built.regularOpen?.toISOString()).toBe('2026-07-15T13:30:00.000Z');
    expect(built.regularClose?.toISOString()).toBe('2026-07-15T20:00:00.000Z');
    expect(built.afterHoursClose?.toISOString()).toBe('2026-07-16T00:00:00.000Z');
  });

  it('shifts every boundary by an hour in winter', () => {
    const built = buildCalendarDay(NYSE, day('2026-01-15'));
    expect(built.regularOpen?.toISOString()).toBe('2026-01-15T14:30:00.000Z');
    expect(built.regularClose?.toISOString()).toBe('2026-01-15T21:00:00.000Z');
  });

  it('marks a weekend closed with no boundaries', () => {
    const built = buildCalendarDay(NYSE, day('2026-09-12'));
    expect(built.isTradingDay).toBe(false);
    expect(built.regularOpen).toBeNull();
    expect(built.afterHoursClose).toBeNull();
  });
});

describe('buildCalendarDay — provider overrides', () => {
  it('closes a weekday the provider reports as a holiday', () => {
    const built = buildCalendarDay(NYSE, day('2026-11-26'), {
      isTradingDay: false,
      regularOpen: null,
      regularClose: null,
      isEarlyClose: false,
      holidayName: 'Thanksgiving',
    });

    expect(built.isTradingDay).toBe(false);
    expect(built.holidayName).toBe('Thanksgiving');
    expect(built.regularOpen).toBeNull();
  });

  it('takes the provider boundaries on an early close', () => {
    const built = buildCalendarDay(NYSE, day('2026-11-27'), {
      isTradingDay: true,
      regularOpen: utc('2026-11-27T14:30:00Z'),
      regularClose: utc('2026-11-27T18:00:00Z'),
      isEarlyClose: true,
      holidayName: 'Thanksgiving',
    });

    expect(built.isTradingDay).toBe(true);
    expect(built.isEarlyClose).toBe(true);
    expect(built.regularClose?.toISOString()).toBe('2026-11-27T18:00:00.000Z');
    // A half day has no extended session; reporting one would invent a
    // tradable window that does not exist.
    expect(built.afterHoursClose).toBeNull();
    // Pre-market still ran, and the provider said nothing about it.
    expect(built.preMarketOpen?.toISOString()).toBe('2026-11-27T09:00:00.000Z');
  });

  it('keeps generated boundaries when the override carries none', () => {
    const built = buildCalendarDay(NYSE, day('2026-07-15'), {
      isTradingDay: true,
      regularOpen: null,
      regularClose: null,
      isEarlyClose: false,
      holidayName: null,
    });
    // A provider row that says nothing must not blank the day out.
    expect(built.regularOpen?.toISOString()).toBe('2026-07-15T13:30:00.000Z');
  });

  it('cannot open a weekend, whatever the provider says', () => {
    const built = buildCalendarDay(NYSE, day('2026-09-12'), {
      isTradingDay: true,
      regularOpen: utc('2026-09-12T13:30:00Z'),
      regularClose: utc('2026-09-12T20:00:00Z'),
      isEarlyClose: false,
      holidayName: null,
    });
    expect(built.isTradingDay).toBe(false);
  });
});

describe('buildCalendarDay — 24/7 markets', () => {
  it('runs midnight to midnight, every day', () => {
    const saturday = buildCalendarDay(CRYPTO, day('2026-09-12'));
    expect(saturday.isTradingDay).toBe(true);
    expect(saturday.regularOpen?.toISOString()).toBe('2026-09-12T00:00:00.000Z');
    expect(saturday.regularClose?.toISOString()).toBe('2026-09-13T00:00:00.000Z');
  });
});

describe('sessionAt', () => {
  const trading = buildCalendarDay(NYSE, day('2026-07-15'));

  it('treats an unknown day as closed', () => {
    // The platform must never infer that a market is open from silence.
    expect(sessionAt(null, utc('2026-07-15T15:00:00Z'))).toBe(MarketSession.CLOSED);
  });

  it('reports closed on a non-trading day', () => {
    const weekend = buildCalendarDay(NYSE, day('2026-09-12'));
    expect(sessionAt(weekend, utc('2026-09-12T15:00:00Z'))).toBe(MarketSession.CLOSED);
  });

  it('reports each session across a full day', () => {
    const cases: [string, MarketSession][] = [
      ['2026-07-15T07:59:59Z', MarketSession.CLOSED],
      ['2026-07-15T08:00:00Z', MarketSession.PRE_MARKET],
      ['2026-07-15T13:29:59Z', MarketSession.PRE_MARKET],
      ['2026-07-15T13:30:00Z', MarketSession.REGULAR],
      ['2026-07-15T19:59:59Z', MarketSession.REGULAR],
      ['2026-07-15T20:00:00Z', MarketSession.AFTER_HOURS],
      ['2026-07-15T23:59:59Z', MarketSession.AFTER_HOURS],
      ['2026-07-16T00:00:00Z', MarketSession.CLOSED],
    ];
    for (const [iso, expected] of cases) {
      expect(sessionAt(trading, utc(iso)), iso).toBe(expected);
    }
  });

  it('treats boundaries as half-open, so no instant is in two sessions', () => {
    expect(sessionAt(trading, utc('2026-07-15T13:30:00Z'))).toBe(MarketSession.REGULAR);
    expect(sessionAt(trading, utc('2026-07-15T20:00:00Z'))).toBe(MarketSession.AFTER_HOURS);
  });

  it('reports closed after an early close, with no extended session', () => {
    const half = buildCalendarDay(NYSE, day('2026-11-27'), {
      isTradingDay: true,
      regularOpen: utc('2026-11-27T14:30:00Z'),
      regularClose: utc('2026-11-27T18:00:00Z'),
      isEarlyClose: true,
      holidayName: 'Thanksgiving',
    });
    expect(sessionAt(half, utc('2026-11-27T17:59:00Z'))).toBe(MarketSession.REGULAR);
    expect(sessionAt(half, utc('2026-11-27T18:30:00Z'))).toBe(MarketSession.CLOSED);
  });

  it('is always regular on a 24/7 market', () => {
    const crypto = buildCalendarDay(CRYPTO, day('2026-09-12'));
    expect(sessionAt(crypto, utc('2026-09-12T03:00:00Z'))).toBe(MarketSession.REGULAR);
    expect(sessionAt(crypto, utc('2026-09-12T23:59:00Z'))).toBe(MarketSession.REGULAR);
  });
});

describe('isTradableSession', () => {
  it('permits regular and both extended sessions', () => {
    expect(isTradableSession(MarketSession.REGULAR)).toBe(true);
    expect(isTradableSession(MarketSession.PRE_MARKET)).toBe(true);
    expect(isTradableSession(MarketSession.AFTER_HOURS)).toBe(true);
  });

  it('refuses closed and halted', () => {
    expect(isTradableSession(MarketSession.CLOSED)).toBe(false);
    expect(isTradableSession(MarketSession.HALTED)).toBe(false);
  });
});

describe('marketCodeFor', () => {
  it('routes crypto to the 24/7 market whatever the venue', () => {
    expect(marketCodeFor(AssetClass.CRYPTO, 'XNAS')).toBe('CRYPTO');
  });

  it('uses a recognised listing venue', () => {
    expect(marketCodeFor(AssetClass.EQUITY, 'XNAS')).toBe('XNAS');
    expect(marketCodeFor(AssetClass.ETF, 'ARCX')).toBe('ARCX');
  });

  it('falls back to NYSE hours for an unknown venue', () => {
    expect(marketCodeFor(AssetClass.EQUITY, 'XLON')).toBe('XNYS');
    expect(marketCodeFor(AssetClass.EQUITY, null)).toBe('XNYS');
  });
});

describe('tradableMsBetween', () => {
  const days: CalendarDay[] = [
    buildCalendarDay(NYSE, day('2026-07-15')),
    buildCalendarDay(NYSE, day('2026-07-16')),
  ];

  it('counts only the regular session by default', () => {
    const total = tradableMsBetween(days, utc('2026-07-15T00:00:00Z'), utc('2026-07-16T00:00:00Z'));
    // 13:30Z to 20:00Z is six and a half hours.
    expect(total).toBe(6.5 * 3_600_000);
  });

  it('counts nothing across an overnight break', () => {
    const total = tradableMsBetween(days, utc('2026-07-15T20:00:00Z'), utc('2026-07-16T13:30:00Z'));
    expect(total).toBe(0);
  });

  it('counts a partial overlap', () => {
    const total = tradableMsBetween(days, utc('2026-07-15T15:00:00Z'), utc('2026-07-15T16:00:00Z'));
    expect(total).toBe(3_600_000);
  });

  it('includes extended sessions when asked', () => {
    const total = tradableMsBetween(
      days,
      utc('2026-07-15T00:00:00Z'),
      utc('2026-07-16T00:00:00Z'),
      [MarketSession.REGULAR, MarketSession.PRE_MARKET, MarketSession.AFTER_HOURS],
    );
    // 08:00Z to 24:00Z, the whole extended day.
    expect(total).toBe(16 * 3_600_000);
  });

  it('skips non-trading days entirely', () => {
    const weekend = [buildCalendarDay(NYSE, day('2026-09-12'))];
    expect(
      tradableMsBetween(weekend, utc('2026-09-12T00:00:00Z'), utc('2026-09-13T00:00:00Z')),
    ).toBe(0);
  });

  it('returns zero for an inverted or empty interval', () => {
    expect(tradableMsBetween(days, utc('2026-07-16T00:00:00Z'), utc('2026-07-15T00:00:00Z'))).toBe(
      0,
    );
    expect(tradableMsBetween([], utc('2026-07-15T00:00:00Z'), utc('2026-07-16T00:00:00Z'))).toBe(0);
  });
});

describe('eachUtcMidnight', () => {
  it('is inclusive of both ends', () => {
    const days = eachUtcMidnight(day('2026-09-10'), day('2026-09-12'));
    expect(days.map((d) => d.toISOString().slice(0, 10))).toEqual([
      '2026-09-10',
      '2026-09-11',
      '2026-09-12',
    ]);
  });

  it('returns one day when both ends match', () => {
    expect(eachUtcMidnight(day('2026-09-10'), day('2026-09-10'))).toHaveLength(1);
  });

  it('normalises a mid-day instant to its midnight', () => {
    const days = eachUtcMidnight(utc('2026-09-10T18:00:00Z'), utc('2026-09-11T03:00:00Z'));
    expect(days.map((d) => d.toISOString())).toEqual([
      '2026-09-10T00:00:00.000Z',
      '2026-09-11T00:00:00.000Z',
    ]);
  });
});
