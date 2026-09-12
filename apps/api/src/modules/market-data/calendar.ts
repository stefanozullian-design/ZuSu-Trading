import { AssetClass, MarketSession } from '@zusu/shared';
import { isoWeekday, parseWallClock, zonedTimeToUtc } from './time-zone.js';
import type { ProviderCalendarDay } from './types.js';

/**
 * The market-calendar engine (§7).
 *
 * The rule this module exists to satisfy is that no code answering "is this
 * tradable right now" may contain 09:30 or 16:00. It doesn't: `sessionAt` reads
 * absolute UTC instants off a dated row and compares them to the instant asked
 * about. Holidays, early closes and daylight-saving shifts are therefore not
 * special cases — they are just rows with different instants in them.
 *
 * The wall-clock strings in `MARKET_DEFINITIONS` are the *generation* input:
 * they are converted once, per date, in the market's own time zone, to produce
 * those rows. That is the opposite of hard-coding a session boundary on the
 * read path, and it is how a real calendar is built — an exchange's ordinary
 * hours are a rule, its exceptions are data.
 */

export interface MarketDefinition {
  /** MIC, or a synthetic code for a venue that has none. */
  code: string;
  name: string;
  /** IANA zone the wall-clock boundaries below are expressed in. */
  timeZone: string;
  /** Trades continuously: weekdays and holidays do not apply. */
  alwaysOpen: boolean;
  /** Local wall-clock session boundaries, "HH:MM". Null where absent. */
  preMarketOpen: string | null;
  regularOpen: string | null;
  regularClose: string | null;
  afterHoursClose: string | null;
  /** ISO weekdays (1 = Monday … 7 = Sunday) on which the market trades. */
  tradingWeekdays: number[];
}

const WEEKDAYS = [1, 2, 3, 4, 5];

export const MARKET_DEFINITIONS: Record<string, MarketDefinition> = {
  XNYS: {
    code: 'XNYS',
    name: 'New York Stock Exchange',
    timeZone: 'America/New_York',
    alwaysOpen: false,
    preMarketOpen: '04:00',
    regularOpen: '09:30',
    regularClose: '16:00',
    afterHoursClose: '20:00',
    tradingWeekdays: WEEKDAYS,
  },
  XNAS: {
    code: 'XNAS',
    name: 'Nasdaq',
    timeZone: 'America/New_York',
    alwaysOpen: false,
    preMarketOpen: '04:00',
    regularOpen: '09:30',
    regularClose: '16:00',
    afterHoursClose: '20:00',
    tradingWeekdays: WEEKDAYS,
  },
  ARCX: {
    code: 'ARCX',
    name: 'NYSE Arca',
    timeZone: 'America/New_York',
    alwaysOpen: false,
    preMarketOpen: '04:00',
    regularOpen: '09:30',
    regularClose: '16:00',
    afterHoursClose: '20:00',
    tradingWeekdays: WEEKDAYS,
  },
  CRYPTO: {
    code: 'CRYPTO',
    name: 'Crypto (24/7)',
    timeZone: 'UTC',
    alwaysOpen: true,
    preMarketOpen: null,
    regularOpen: null,
    regularClose: null,
    afterHoursClose: null,
    tradingWeekdays: [1, 2, 3, 4, 5, 6, 7],
  },
};

/** The market an instrument trades on, from its class and listing venue. */
export function marketCodeFor(assetClass: AssetClass, exchange?: string | null): string {
  if (assetClass === AssetClass.CRYPTO) return 'CRYPTO';
  if (exchange && MARKET_DEFINITIONS[exchange]) return exchange;
  // An equity on an unrecognised venue follows NYSE hours, which every US
  // venue shares. Recorded as XNYS rather than guessed per-symbol.
  return 'XNYS';
}

/** A dated calendar row, as stored and as the read path consumes it. */
export interface CalendarDay {
  marketCode: string;
  /** UTC midnight of the market-local date this row describes. */
  date: Date;
  isTradingDay: boolean;
  preMarketOpen: Date | null;
  regularOpen: Date | null;
  regularClose: Date | null;
  afterHoursClose: Date | null;
  isEarlyClose: boolean;
  holidayName: string | null;
}

/**
 * Builds the row for one market-local date.
 *
 * `override` carries what the provider knows that the rule does not: a holiday
 * closure or an early close. Provider boundaries win over generated ones —
 * they are observations, and the rule is only a default.
 */
export function buildCalendarDay(
  definition: MarketDefinition,
  date: Date,
  override?: Pick<
    ProviderCalendarDay,
    'isTradingDay' | 'regularOpen' | 'regularClose' | 'isEarlyClose' | 'holidayName'
  > | null,
): CalendarDay {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();

  if (definition.alwaysOpen) {
    // A continuous market still gets dated rows, so the read path stays
    // identical and a gap query has something to compare against.
    return {
      marketCode: definition.code,
      date,
      isTradingDay: true,
      preMarketOpen: null,
      regularOpen: new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0)),
      regularClose: new Date(Date.UTC(year, month - 1, day + 1, 0, 0, 0, 0)),
      afterHoursClose: null,
      isEarlyClose: false,
      holidayName: null,
    };
  }

  const at = (wallClock: string | null): Date | null => {
    if (!wallClock) return null;
    const { hour, minute } = parseWallClock(wallClock);
    return zonedTimeToUtc(year, month, day, hour, minute, definition.timeZone);
  };

  const isWeekday = definition.tradingWeekdays.includes(isoWeekday(date));
  const closedByProvider = override?.isTradingDay === false;
  const isTradingDay = isWeekday && !closedByProvider;

  if (!isTradingDay) {
    return {
      marketCode: definition.code,
      date,
      isTradingDay: false,
      preMarketOpen: null,
      regularOpen: null,
      regularClose: null,
      afterHoursClose: null,
      isEarlyClose: false,
      holidayName: override?.holidayName ?? null,
    };
  }

  const regularOpen = override?.regularOpen ?? at(definition.regularOpen);
  const regularClose = override?.regularClose ?? at(definition.regularClose);
  const isEarlyClose = override?.isEarlyClose ?? false;

  return {
    marketCode: definition.code,
    date,
    isTradingDay: true,
    preMarketOpen: at(definition.preMarketOpen),
    regularOpen,
    regularClose,
    // An early close ends the whole day: there is no extended session after a
    // half day, so reporting one would invent a tradable window.
    afterHoursClose: isEarlyClose ? null : at(definition.afterHoursClose),
    isEarlyClose,
    holidayName: override?.holidayName ?? null,
  };
}

/**
 * The session in force at `at`, given the row for that market-local date.
 *
 * A missing row means CLOSED. That is the whole point of the default: the
 * platform must never infer that a market is open from the absence of
 * information about it.
 */
export function sessionAt(day: CalendarDay | null, at: Date): MarketSession {
  if (!day || !day.isTradingDay) return MarketSession.CLOSED;

  const instant = at.getTime();
  const within = (from: Date | null, to: Date | null): boolean =>
    from !== null && to !== null && instant >= from.getTime() && instant < to.getTime();

  if (within(day.regularOpen, day.regularClose)) return MarketSession.REGULAR;
  if (within(day.preMarketOpen, day.regularOpen)) return MarketSession.PRE_MARKET;
  if (within(day.regularClose, day.afterHoursClose)) return MarketSession.AFTER_HOURS;
  return MarketSession.CLOSED;
}

/** Sessions in which an order may rest at a venue at all. */
export function isTradableSession(session: MarketSession): boolean {
  return (
    session === MarketSession.REGULAR ||
    session === MarketSession.PRE_MARKET ||
    session === MarketSession.AFTER_HOURS
  );
}

/**
 * Total tradable milliseconds between two instants, across a run of days.
 *
 * This is what makes gap detection honest: a hole between two bars matters only
 * to the extent the market was actually open across it, so an overnight break
 * contributes nothing and a genuine outage contributes its full duration.
 */
export function tradableMsBetween(
  days: CalendarDay[],
  from: Date,
  to: Date,
  sessions: MarketSession[] = [MarketSession.REGULAR],
): number {
  if (to.getTime() <= from.getTime()) return 0;
  const includeExtended = sessions.includes(MarketSession.PRE_MARKET);
  const includeAfter = sessions.includes(MarketSession.AFTER_HOURS);

  let total = 0;
  for (const day of days) {
    if (!day.isTradingDay) continue;

    const windows: [Date | null, Date | null][] = [[day.regularOpen, day.regularClose]];
    if (includeExtended) windows.push([day.preMarketOpen, day.regularOpen]);
    if (includeAfter) windows.push([day.regularClose, day.afterHoursClose]);

    for (const [start, end] of windows) {
      if (!start || !end) continue;
      const overlapStart = Math.max(start.getTime(), from.getTime());
      const overlapEnd = Math.min(end.getTime(), to.getTime());
      if (overlapEnd > overlapStart) total += overlapEnd - overlapStart;
    }
  }
  return total;
}

/** UTC midnights from `from` to `to` inclusive. */
export function eachUtcMidnight(from: Date, to: Date): Date[] {
  const days: Date[] = [];
  const cursor = new Date(
    Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), 0, 0, 0, 0),
  );
  const end = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate(), 0, 0, 0, 0);
  while (cursor.getTime() <= end) {
    days.push(new Date(cursor.getTime()));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}
