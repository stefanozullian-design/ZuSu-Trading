import { describe, expect, it } from 'vitest';
import { usHolidayIndex, usMarketHolidays } from './us-market-holidays.js';

/**
 * Dates a trading platform must not need an API to know.
 *
 * Checked against the exchanges' published schedules rather than against the
 * implementation: a computus with a sign error still computes something.
 */

const on = (year: number, name: string): string | undefined =>
  usMarketHolidays(year)
    .find((holiday) => holiday.name === name)
    ?.date.toISOString()
    .slice(0, 10);

describe('fixed dates and their observed shifts', () => {
  it('moves a Saturday holiday to the Friday before', () => {
    // 4 July 2026 is a Saturday; the exchanges close on Friday the 3rd.
    expect(on(2026, 'Independence Day')).toBe('2026-07-03');
  });

  it('moves a Sunday holiday to the Monday after', () => {
    // 25 December 2022 was a Sunday; the closure was Monday the 26th.
    expect(on(2022, 'Christmas Day')).toBe('2022-12-26');
  });

  it('leaves a weekday holiday where it is', () => {
    expect(on(2025, 'Independence Day')).toBe('2025-07-04');
  });
});

describe('floating dates', () => {
  it('finds the third Monday in January and February', () => {
    expect(on(2026, 'Martin Luther King Jr. Day')).toBe('2026-01-19');
    expect(on(2026, "Washington's Birthday")).toBe('2026-02-16');
  });

  it('finds the last Monday in May', () => {
    expect(on(2026, 'Memorial Day')).toBe('2026-05-25');
    expect(on(2027, 'Memorial Day')).toBe('2027-05-31');
  });

  it('finds the fourth Thursday in November', () => {
    expect(on(2026, 'Thanksgiving Day')).toBe('2026-11-26');
    expect(on(2025, 'Thanksgiving Day')).toBe('2025-11-27');
  });

  it('computes Good Friday from Easter', () => {
    // Easter Sunday 2026 falls on 5 April; 2025 on 20 April.
    expect(on(2026, 'Good Friday')).toBe('2026-04-03');
    expect(on(2025, 'Good Friday')).toBe('2025-04-18');
  });
});

describe('Juneteenth', () => {
  it('is observed from 2022, the first year the exchanges closed for it', () => {
    expect(on(2022, 'Juneteenth National Independence Day')).toBe('2022-06-20');
    expect(on(2026, 'Juneteenth National Independence Day')).toBe('2026-06-19');
  });

  it('does not exist before then', () => {
    expect(on(2021, 'Juneteenth National Independence Day')).toBeUndefined();
  });
});

describe('early closes never displace a full closure', () => {
  it('keeps 3 July 2026 shut rather than half-open', () => {
    // The 4th is a Saturday, so the 3rd is the closure — and it is also where
    // the "day before Independence Day" early close would land. Letting the
    // early close win turned a shut day back into a trading day, and the
    // absent bar was then reported as dropped data.
    const index = usHolidayIndex(new Date('2026-07-01'), new Date('2026-07-31'));
    const third = index.get('2026-07-03');
    expect(third?.name).toBe('Independence Day');
    expect(third?.earlyClose).toBeUndefined();
  });

  it('still records the genuine early closes', () => {
    const index = usHolidayIndex(new Date('2026-11-01'), new Date('2026-12-31'));
    expect(index.get('2026-11-27')?.earlyClose).toBe(true); // day after Thanksgiving
    expect(index.get('2026-12-24')?.earlyClose).toBe(true); // Christmas Eve, a Thursday
  });
});

describe('the index', () => {
  it('covers every year a range spans', () => {
    const index = usHolidayIndex(new Date('2025-12-01'), new Date('2026-02-01'));
    expect(index.has('2025-12-25')).toBe(true);
    expect(index.has('2026-01-01')).toBe(true);
  });
});
