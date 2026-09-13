import type { PrismaClient } from '@prisma/client';
import { AssetClass, MarketSession } from '@zusu/shared';
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
import { zonedDateParts } from './time-zone.js';
import { usHolidayIndex } from './us-market-holidays.js';
import type { MarketDataProvider, ProviderCalendarDay, Timeframe } from './types.js';
import { TIMEFRAME_MINUTES } from './types.js';

/**
 * Database-backed market calendar (§7).
 *
 * Answers three questions, and nothing it does to answer them contains a
 * session boundary as a literal:
 *
 *   - what session is this market in at this instant
 *   - may this specific symbol be traded at this instant, and if not, why
 *   - was the market open between these two instants (for gap detection)
 *
 * Rows are generated from a market definition and then corrected by whatever
 * the provider reports — holidays and early closes. Generation is explicit and
 * dated, so a deployment that has not synced its calendar returns CLOSED rather
 * than assuming a market it knows nothing about is open.
 */

export interface TradabilityVerdict {
  tradable: boolean;
  session: MarketSession;
  marketCode: string;
  /** Human-readable reason when not tradable. Null when it is. */
  reason: string | null;
  /**
   * When the market next opens, if it is currently shut and the calendar
   * reaches that far. Null when it is open, when the reason has nothing to do
   * with the clock (a halt, an untradable instrument), or when no synced day
   * answers the question — in which case saying nothing beats guessing.
   */
  nextOpen: Date | null;
}

export interface SyncSummary {
  marketCode: string;
  daysWritten: number;
  holidaysApplied: number;
  from: Date;
  to: Date;
}

export class MarketCalendarService {
  constructor(private readonly db: PrismaClient) {}

  /**
   * Generates calendar rows for a market over a date range, applying whatever
   * exceptions the provider knows about.
   *
   * Idempotent: re-running over the same range corrects existing rows rather
   * than duplicating them, so a later sync that learns about a newly announced
   * early close fixes the day already stored for it.
   */
  async sync(
    marketCode: string,
    from: Date,
    to: Date,
    provider?: MarketDataProvider | null,
  ): Promise<SyncSummary> {
    const definition = MARKET_DEFINITIONS[marketCode];
    if (!definition) {
      throw new Error(`No market definition for ${marketCode}`);
    }

    const overrides = new Map<string, ProviderCalendarDay>();
    if (provider) {
      // A provider failure must not silently produce a calendar with no
      // holidays in it — that calendar would report Thanksgiving as a normal
      // trading day. Let it throw; the caller decides whether to proceed.
      for (const day of await provider.getCalendar(marketCode, from, to)) {
        // Only genuine exceptions are worth overriding with; a provider row
        // that says nothing (open, boundaries unknown) must not blank out the
        // generated boundaries.
        if (!day.isTradingDay || day.isEarlyClose || day.holidayName) {
          overrides.set(isoDateKey(day.date), day);
        }
      }
    }

    // Known closures for the years this range spans. A provider row still
    // wins — a real closure this table does not know about must override a
    // computed ordinary day — but without the table a historical sync has no
    // holidays at all, because Massive reports only upcoming ones.
    const knownHolidays = definition.alwaysOpen ? new Map() : usHolidayIndex(from, to);

    let daysWritten = 0;
    for (const date of eachUtcMidnight(from, to)) {
      const key = isoDateKey(date);
      const provided = overrides.get(key) ?? null;
      const known = knownHolidays.get(key);
      const override =
        provided ??
        (known
          ? {
              isTradingDay: known.earlyClose === true,
              regularOpen: null,
              regularClose: null,
              isEarlyClose: known.earlyClose === true,
              holidayName: known.name,
            }
          : null);
      const day = buildCalendarDay(definition, date, override);

      await this.db.marketCalendarDay.upsert({
        where: { marketCode_date: { marketCode: day.marketCode, date: day.date } },
        create: {
          marketCode: day.marketCode,
          date: day.date,
          isTradingDay: day.isTradingDay,
          preMarketOpen: day.preMarketOpen,
          regularOpen: day.regularOpen,
          regularClose: day.regularClose,
          afterHoursClose: day.afterHoursClose,
          isEarlyClose: day.isEarlyClose,
          holidayName: day.holidayName,
        },
        update: {
          isTradingDay: day.isTradingDay,
          preMarketOpen: day.preMarketOpen,
          regularOpen: day.regularOpen,
          regularClose: day.regularClose,
          afterHoursClose: day.afterHoursClose,
          isEarlyClose: day.isEarlyClose,
          holidayName: day.holidayName,
        },
      });
      daysWritten += 1;
    }

    return { marketCode, daysWritten, holidaysApplied: overrides.size, from, to };
  }

  /** The stored row for the market-local date containing `at`, if any. */
  async dayFor(marketCode: string, at: Date): Promise<CalendarDay | null> {
    const definition = MARKET_DEFINITIONS[marketCode];
    const timeZone = definition?.timeZone ?? 'UTC';
    // The row is keyed by the market's own local date, so 21:00 in New York on
    // a Friday must not read Saturday's row just because it is Saturday in UTC.
    const { year, month, day } = zonedDateParts(at, timeZone);
    const date = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));

    const row = await this.db.marketCalendarDay.findUnique({
      where: { marketCode_date: { marketCode, date } },
    });
    return row ? toCalendarDay(row) : null;
  }

  /** The session `marketCode` is in at `at`. CLOSED when the day is unknown. */
  async sessionFor(marketCode: string, at: Date = new Date()): Promise<MarketSession> {
    return sessionAt(await this.dayFor(marketCode, at), at);
  }

  /**
   * The next instant this market opens, or null if no synced day says.
   *
   * Deliberately bounded: it reads the calendar rows that exist rather than
   * projecting a schedule forward. A calendar synced only to Friday cannot
   * honestly tell you about Monday, and inventing the answer is how a system
   * ends up promising an open that a holiday cancels.
   */
  async nextOpen(marketCode: string, at: Date = new Date()): Promise<Date | null> {
    const day = await this.db.marketCalendarDay.findFirst({
      where: {
        marketCode,
        isTradingDay: true,
        regularOpen: { gt: at },
      },
      orderBy: { regularOpen: 'asc' },
      select: { regularOpen: true },
    });
    return day?.regularOpen ?? null;
  }

  /**
   * Whether one symbol may be traded at `at`, and why not when it may not.
   *
   * Four independent reasons a symbol is untradable, checked in order of
   * specificity: it is not a known instrument, it is not tradable at all, it is
   * halted, or its market is closed.
   */
  async isTradable(symbol: string, at: Date = new Date()): Promise<TradabilityVerdict> {
    const instrument = await this.db.instrument.findUnique({
      where: { symbol },
      select: { id: true, assetClass: true, exchange: true, isTradable: true },
    });

    if (!instrument) {
      return {
        tradable: false,
        session: MarketSession.CLOSED,
        marketCode: 'UNKNOWN',
        reason: `${symbol} is not a known instrument.`,
        nextOpen: null,
      };
    }

    const marketCode = marketCodeFor(instrument.assetClass as AssetClass, instrument.exchange);

    if (!instrument.isTradable) {
      return {
        tradable: false,
        session: MarketSession.CLOSED,
        marketCode,
        reason: `${symbol} is not tradable on this platform.`,
        nextOpen: null,
      };
    }

    const halt = await this.db.tradingHalt.findFirst({
      where: { symbol, releasedAt: null },
      orderBy: { haltedAt: 'desc' },
    });
    if (halt) {
      return {
        tradable: false,
        // HALTED is distinct from CLOSED on purpose: the market may well be
        // open, and a caller that conflates the two would retry at the open.
        session: MarketSession.HALTED,
        marketCode,
        reason: `${symbol} is halted (${halt.reason})${halt.detail ? `: ${halt.detail}` : ''}.`,
        // A halt is not a clock problem, so the next open answers nothing.
        nextOpen: null,
      };
    }

    const session = await this.sessionFor(marketCode, at);
    if (!isTradableSession(session)) {
      const [day, nextOpen] = await Promise.all([
        this.dayFor(marketCode, at),
        this.nextOpen(marketCode, at),
      ]);
      return {
        tradable: false,
        session,
        marketCode,
        reason: day
          ? `${marketCode} is closed${day.holidayName ? ` for ${day.holidayName}` : ''}${
              nextOpen ? `, and opens next at ${nextOpen.toISOString()}` : ''
            }.`
          : `No calendar is loaded for ${marketCode} on ${at.toISOString()}. ` +
            'Sync the calendar before trading.',
        nextOpen,
      };
    }

    return { tradable: true, session, marketCode, reason: null, nextOpen: null };
  }

  /** Records a halt. Re-halting an already-halted symbol is a no-op. */
  async recordHalt(
    symbol: string,
    options: { reason: string; detail?: string | null; source: string },
  ): Promise<void> {
    const instrument = await this.db.instrument.findUnique({
      where: { symbol },
      select: { id: true },
    });
    if (!instrument) {
      throw new Error(`No instrument record exists for ${symbol}`);
    }

    const existing = await this.db.tradingHalt.findFirst({
      where: { symbol, releasedAt: null },
      select: { id: true },
    });
    if (existing) return;

    await this.db.tradingHalt.create({
      data: {
        instrumentId: instrument.id,
        symbol,
        reason: options.reason,
        detail: options.detail ?? null,
        source: options.source,
      },
    });
  }

  /** Releases any open halt on a symbol. */
  async releaseHalt(symbol: string): Promise<void> {
    await this.db.tradingHalt.updateMany({
      where: { symbol, releasedAt: null },
      data: { releasedAt: new Date() },
    });
  }

  /** Symbols currently halted. */
  async openHalts(): Promise<{ symbol: string; reason: string; haltedAt: Date }[]> {
    const rows = await this.db.tradingHalt.findMany({
      where: { releasedAt: null },
      orderBy: { haltedAt: 'desc' },
      select: { symbol: true, reason: true, haltedAt: true },
    });
    return rows;
  }

  /**
   * A resolver for `inspectCandles`, closing the gap-detection limitation the
   * quality layer shipped with.
   *
   * Returns true when no bar is actually missing: the market was open for at
   * most one bar's worth of time between the two bar *starts*. Two consecutive
   * bars enclose exactly one interval of open market — the earlier bar occupies
   * it — so the boundary is inclusive. Anything more than one interval of open
   * market between them means bars really did go missing.
   *
   * This is what makes an overnight break stop reading as a hole: between the
   * day's last bar and the next day's first, only that last bar's own minute
   * was tradable.
   */
  async gapResolverFor(
    marketCode: string,
    timeframe: Timeframe,
    from: Date,
    to: Date,
    sessions: MarketSession[] = [MarketSession.REGULAR],
  ): Promise<(gapFrom: Date, gapTo: Date) => boolean> {
    const intervalMs = TIMEFRAME_MINUTES[timeframe] * 60_000;

    // Loaded once for the whole range, which is what lets the returned function
    // be synchronous — `inspectCandles` takes a pure predicate, not a promise.
    const rows = await this.db.marketCalendarDay.findMany({
      where: { marketCode, date: { gte: utcMidnight(from), lte: utcMidnight(to) } },
    });
    const days = rows.map(toCalendarDay);

    if (timeframe === '1d') {
      // Daily bars are counted in sessions, not in milliseconds.
      //
      // Every other timeframe measures a bar in tradable minutes, so comparing
      // tradable time against the bar's interval is sound. A daily bar does
      // not work that way: its interval is 1440 wall-clock minutes while the
      // session it covers is about 390 tradable ones. Two whole missing
      // sessions still fit comfortably inside one day's worth of milliseconds,
      // so the millisecond comparison excused a genuinely absent trading day
      // exactly as readily as it excused a weekend.
      const tradingDates = days
        .filter((day) => day.isTradingDay)
        .map((day) => day.date.getTime())
        .sort((a, b) => a - b);

      return (gapFrom: Date, gapTo: Date): boolean => {
        if (days.length === 0) return false;
        const after = utcMidnight(gapFrom).getTime();
        const before = utcMidnight(gapTo).getTime();
        // A session strictly between the two bars is a bar that should exist.
        return !tradingDates.some((date) => date > after && date < before);
      };
    }

    return (gapFrom: Date, gapTo: Date): boolean => {
      if (days.length === 0) {
        // No calendar loaded for this range: we cannot claim the market was
        // shut, so the gap stands and a human sees the finding.
        return false;
      }
      return tradableMsBetween(days, gapFrom, gapTo, sessions) <= intervalMs;
    };
  }

  /**
   * Whether the market was effectively shut between two instants.
   *
   * The async counterpart to the resolver above, for callers that can await.
   */
  async isSessionGap(
    marketCode: string,
    from: Date,
    to: Date,
    timeframe: Timeframe,
    sessions: MarketSession[] = [MarketSession.REGULAR],
  ): Promise<boolean> {
    const rows = await this.db.marketCalendarDay.findMany({
      where: {
        marketCode,
        date: { gte: utcMidnight(from), lte: utcMidnight(to) },
      },
    });
    if (rows.length === 0) {
      // No calendar loaded: cannot claim the market was shut, so the gap stands.
      return false;
    }

    const tradableMs = tradableMsBetween(rows.map(toCalendarDay), from, to, sessions);
    return tradableMs <= TIMEFRAME_MINUTES[timeframe] * 60_000;
  }
}

type CalendarRow = {
  marketCode: string;
  date: Date;
  isTradingDay: boolean;
  preMarketOpen: Date | null;
  regularOpen: Date | null;
  regularClose: Date | null;
  afterHoursClose: Date | null;
  isEarlyClose: boolean;
  holidayName: string | null;
};

function toCalendarDay(row: CalendarRow): CalendarDay {
  return {
    marketCode: row.marketCode,
    date: row.date,
    isTradingDay: row.isTradingDay,
    preMarketOpen: row.preMarketOpen,
    regularOpen: row.regularOpen,
    regularClose: row.regularClose,
    afterHoursClose: row.afterHoursClose,
    isEarlyClose: row.isEarlyClose,
    holidayName: row.holidayName,
  };
}

function isoDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function utcMidnight(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 0, 0, 0),
  );
}
