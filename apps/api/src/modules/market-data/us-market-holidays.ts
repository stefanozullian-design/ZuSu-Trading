/**
 * US equity market holidays, computed rather than fetched.
 *
 * The calendar engine builds ordinary sessions from a rule and treats
 * exceptions as data — which is right, and left one question unanswered: where
 * do the exceptions come from? Until now, only from a market-data provider.
 * Massive's calendar endpoint returns *upcoming* holidays only, so a sync of
 * the last ninety days learns nothing about the holidays inside it, and every
 * one of them is reported as a day the market was open and sent no bar.
 *
 * That is what the first real sync produced: Juneteenth and Independence Day
 * flagged as dropped data on all eight symbols.
 *
 * These dates are not a feed. They are published rules, stable for decades,
 * and a platform that cannot work out that the market is shut on Christmas
 * without asking an API is a platform with a dependency it should not have.
 * A provider row still overrides anything here — a real closure this table
 * does not know about must win.
 */

interface Holiday {
  name: string;
  /** UTC midnight of the observed date. */
  date: Date;
  /** Closes early (13:00 New York) rather than closing entirely. */
  earlyClose?: boolean;
}

const utc = (year: number, month: number, day: number): Date =>
  new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));

/** Saturday closures are observed on the Friday, Sunday's on the Monday. */
function observed(date: Date): Date {
  const weekday = date.getUTCDay();
  if (weekday === 6) return new Date(date.getTime() - 86_400_000);
  if (weekday === 0) return new Date(date.getTime() + 86_400_000);
  return date;
}

/** The nth given weekday of a month; n = -1 means the last one. */
function nthWeekday(year: number, month: number, weekday: number, n: number): Date {
  if (n > 0) {
    const first = utc(year, month, 1);
    const shift = (weekday - first.getUTCDay() + 7) % 7;
    return utc(year, month, 1 + shift + (n - 1) * 7);
  }
  const last = new Date(Date.UTC(year, month, 0));
  const shift = (last.getUTCDay() - weekday + 7) % 7;
  return new Date(last.getTime() - shift * 86_400_000);
}

/** Anonymous Gregorian computus. Good Friday is Easter minus two days. */
function easterSunday(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return utc(year, month, day);
}

/**
 * Every NYSE/Nasdaq closure and early close in a calendar year.
 *
 * Juneteenth is included from 2022, the first year the exchanges observed it.
 */
export function usMarketHolidays(year: number): Holiday[] {
  const holidays: Holiday[] = [
    { name: "New Year's Day", date: observed(utc(year, 1, 1)) },
    { name: 'Martin Luther King Jr. Day', date: nthWeekday(year, 1, 1, 3) },
    { name: "Washington's Birthday", date: nthWeekday(year, 2, 1, 3) },
    { name: 'Good Friday', date: new Date(easterSunday(year).getTime() - 2 * 86_400_000) },
    { name: 'Memorial Day', date: nthWeekday(year, 5, 1, -1) },
    { name: 'Independence Day', date: observed(utc(year, 7, 4)) },
    { name: 'Labor Day', date: nthWeekday(year, 9, 1, 1) },
    { name: 'Thanksgiving Day', date: nthWeekday(year, 11, 4, 4) },
    { name: 'Christmas Day', date: observed(utc(year, 12, 25)) },
  ];

  if (year >= 2022) {
    holidays.push({
      name: 'Juneteenth National Independence Day',
      date: observed(utc(year, 6, 19)),
    });
  }

  // Early closes: 13:00 New York rather than 16:00.
  const thanksgiving = nthWeekday(year, 11, 4, 4);
  holidays.push({
    name: 'Day after Thanksgiving',
    date: new Date(thanksgiving.getTime() + 86_400_000),
    earlyClose: true,
  });

  const christmasEve = utc(year, 12, 24);
  if (christmasEve.getUTCDay() >= 1 && christmasEve.getUTCDay() <= 5) {
    holidays.push({ name: 'Christmas Eve', date: christmasEve, earlyClose: true });
  }

  const julyThird = utc(year, 7, 3);
  if (
    julyThird.getUTCDay() >= 1 &&
    julyThird.getUTCDay() <= 5 &&
    utc(year, 7, 4).getUTCDay() !== 0
  ) {
    holidays.push({ name: 'Day before Independence Day', date: julyThird, earlyClose: true });
  }

  return holidays;
}

/**
 * Indexed by `YYYY-MM-DD`, for the years a date range spans.
 *
 * A full closure always beats an early close on the same date. The two collide
 * more often than you would guess: when Independence Day falls on a Saturday
 * the market shuts on Friday the 3rd, which is also the date the "day before
 * Independence Day" early close would land on. Letting the early close win
 * turned a closed day back into a trading day, and the missing bar was
 * reported as dropped data — which is precisely how this was found.
 */
export function usHolidayIndex(from: Date, to: Date): Map<string, Holiday> {
  const index = new Map<string, Holiday>();
  for (let year = from.getUTCFullYear(); year <= to.getUTCFullYear(); year += 1) {
    const holidays = usMarketHolidays(year);
    // Closures first, then early closes, and never overwrite what is there.
    for (const holiday of holidays.filter((h) => h.earlyClose !== true)) {
      index.set(holiday.date.toISOString().slice(0, 10), holiday);
    }
    for (const holiday of holidays.filter((h) => h.earlyClose === true)) {
      const key = holiday.date.toISOString().slice(0, 10);
      if (!index.has(key)) index.set(key, holiday);
    }
  }
  return index;
}

export type { Holiday };
