import { describe, expect, it } from 'vitest';
import { PORTFOLIO_OBJECTIVES, PortfolioObjective } from './enums.js';
import { OBJECTIVE_LABELS, RISK_PROFILES, riskProfileFor } from './objectives.js';

/**
 * Starting risk limits by objective.
 *
 * The table is data, so the things worth testing are the properties a careless
 * edit would break silently: that the limits tighten as the horizon lengthens,
 * that every objective has a profile and a label, and that a portfolio with no
 * stated objective keeps the limits it already had.
 */

const TIGHTENING = ['DAY_TRADING', 'GROWTH', 'INCOME', 'RETIREMENT'] as const;

describe('the profiles', () => {
  it('covers every objective, with nothing left to fall through', () => {
    for (const objective of PORTFOLIO_OBJECTIVES) {
      expect(RISK_PROFILES[objective], objective).toBeDefined();
      expect(OBJECTIVE_LABELS[objective]?.title, objective).toBeTruthy();
    }
  });

  it('tightens monotonically from day trading to retirement', () => {
    // The property a reader assumes and an edit to one row would break. Every
    // limit is a ceiling, so each step may lower it or leave it, never raise.
    const keys = Object.keys(RISK_PROFILES.DAY_TRADING) as (keyof typeof RISK_PROFILES.GROWTH)[];

    for (let i = 1; i < TIGHTENING.length; i += 1) {
      const looser = RISK_PROFILES[TIGHTENING[i - 1]!];
      const tighter = RISK_PROFILES[TIGHTENING[i]!];
      for (const key of keys) {
        expect(tighter[key], `${TIGHTENING[i]!}.${key}`).toBeLessThanOrEqual(looser[key]);
      }
    }
  });

  it('is strictly tighter end to end, not merely non-increasing', () => {
    // Every limit actually moves between the widest and the tightest; a row
    // copied wholesale would satisfy the test above and mean nothing.
    const day = RISK_PROFILES.DAY_TRADING;
    const retirement = RISK_PROFILES.RETIREMENT;
    for (const key of Object.keys(day) as (keyof typeof day)[]) {
      expect(retirement[key], key).toBeLessThan(day[key]);
    }
  });

  it('leaves a portfolio with no stated objective on the widest profile', () => {
    // Portfolios created before objectives existed have none. Tightening their
    // limits retroactively would change how they behave without anyone asking.
    expect(riskProfileFor(null)).toEqual(RISK_PROFILES.DAY_TRADING);
    expect(riskProfileFor(undefined)).toEqual(RISK_PROFILES.DAY_TRADING);
    expect(riskProfileFor(PortfolioObjective.RETIREMENT)).toEqual(RISK_PROFILES.RETIREMENT);
  });

  it('keeps every limit positive, so none of them means "no limit"', () => {
    for (const objective of PORTFOLIO_OBJECTIVES) {
      const profile = RISK_PROFILES[objective];
      for (const [key, value] of Object.entries(profile)) {
        expect(value, `${objective}.${key}`).toBeGreaterThan(0);
      }
    }
  });
});
