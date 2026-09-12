/**
 * Wall-clock to UTC conversion for a named IANA time zone.
 *
 * Written against `Intl` rather than pulling in a date library: the platform
 * needs exactly one operation — "what UTC instant is 09:30 in New York on this
 * date" — and that operation has to be right across daylight-saving
 * transitions, which is precisely where a hand-rolled fixed offset fails.
 *
 * The market calendar calls this once per day when generating rows, never on
 * the read path. Stored session boundaries are absolute instants, so nothing
 * re-derives an offset when answering "is the market open now".
 */

/**
 * The offset, in milliseconds, that `timeZone` was at the given UTC instant.
 * Positive east of Greenwich.
 */
export function zoneOffsetMs(instant: Date, timeZone: string): number {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  const parts: Record<string, number> = {};
  for (const part of formatter.formatToParts(instant)) {
    if (part.type !== 'literal') {
      parts[part.type] = Number(part.value);
    }
  }

  const asIfUtc = Date.UTC(
    parts.year as number,
    (parts.month as number) - 1,
    parts.day as number,
    parts.hour as number,
    parts.minute as number,
    parts.second as number,
  );
  // Millisecond precision is irrelevant to a zone offset and formatToParts
  // does not report it, so compare on whole seconds.
  return asIfUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * The UTC instant at which the given local wall-clock time occurs in
 * `timeZone`.
 *
 * Two passes: guess with the offset in force at the naive instant, then
 * re-read the offset at that result and correct. The second pass is what makes
 * a time on the far side of a DST boundary come out right.
 *
 * Ambiguous and non-existent local times (the hour that repeats or vanishes at
 * a transition) resolve to a single defensible instant rather than throwing.
 * No market session boundary sits in such an hour — US equity transitions
 * happen at 02:00 local on a Sunday — so this is not a case the calendar needs
 * to agonise over, but it must not produce an invalid date.
 */
export function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const naive = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  const firstGuess = naive - zoneOffsetMs(new Date(naive), timeZone);
  const corrected = naive - zoneOffsetMs(new Date(firstGuess), timeZone);
  return new Date(corrected);
}

/** Parses "HH:MM" into its parts. Throws on anything else. */
export function parseWallClock(value: string): { hour: number; minute: number } {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!match) {
    throw new Error(`Invalid wall-clock time "${value}"; expected HH:MM`);
  }
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

/** The calendar date in `timeZone` at the given UTC instant, as y/m/d parts. */
export function zonedDateParts(
  instant: Date,
  timeZone: string,
): { year: number; month: number; day: number } {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts: Record<string, number> = {};
  for (const part of formatter.formatToParts(instant)) {
    if (part.type !== 'literal') {
      parts[part.type] = Number(part.value);
    }
  }
  return {
    year: parts.year as number,
    month: parts.month as number,
    day: parts.day as number,
  };
}

/** ISO weekday (1 = Monday … 7 = Sunday) for a UTC-midnight date. */
export function isoWeekday(utcMidnight: Date): number {
  const day = utcMidnight.getUTCDay();
  return day === 0 ? 7 : day;
}
