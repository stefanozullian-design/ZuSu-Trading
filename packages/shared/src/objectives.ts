import { PortfolioObjective } from './enums.js';

/**
 * Starting risk limits, by what the money is for.
 *
 * Every portfolio used to begin with one set of defaults, written for
 * day trading. Applied to money meant for a retirement thirty years out, those
 * defaults permit a 15% drawdown and twenty trades a day — not a cautious
 * starting point but a wrong one, and wrong in the direction nobody notices
 * until it has already happened.
 *
 * These are *starting* limits and nothing more. An administrator can change
 * any of them afterwards, and the risk engine enforces whatever is stored, not
 * what is written here. What this table buys is that the first day of a
 * retirement portfolio is not governed by a day trader's appetite.
 *
 * The numbers tighten monotonically from DAY_TRADING to RETIREMENT, which is
 * a property worth stating because it is the one a reader will assume and the
 * one a careless edit would break. A test asserts it.
 */
export interface RiskProfile {
  /** Fractions of starting capital, not percentages. */
  maxDailyLossPctOfCapital: number;
  maxWeeklyLossPctOfCapital: number;
  maxPositionSizePctOfCapital: number;
  /** Whole percentages, as the risk engine stores them. */
  maxPortfolioExposurePct: number;
  maxSectorExposurePct: number;
  maxSymbolExposurePct: number;
  maxOpenPositions: number;
  maxTradesPerDay: number;
  maxConsecutiveLosses: number;
  maxDrawdownPct: number;
}

export const RISK_PROFILES: Record<PortfolioObjective, RiskProfile> = {
  DAY_TRADING: {
    maxDailyLossPctOfCapital: 0.02,
    maxWeeklyLossPctOfCapital: 0.05,
    maxPositionSizePctOfCapital: 0.1,
    maxPortfolioExposurePct: 60,
    maxSectorExposurePct: 30,
    maxSymbolExposurePct: 15,
    maxOpenPositions: 10,
    maxTradesPerDay: 20,
    maxConsecutiveLosses: 4,
    maxDrawdownPct: 15,
  },
  GROWTH: {
    maxDailyLossPctOfCapital: 0.015,
    maxWeeklyLossPctOfCapital: 0.04,
    maxPositionSizePctOfCapital: 0.08,
    maxPortfolioExposurePct: 55,
    maxSectorExposurePct: 25,
    maxSymbolExposurePct: 12,
    maxOpenPositions: 8,
    maxTradesPerDay: 6,
    maxConsecutiveLosses: 3,
    maxDrawdownPct: 12,
  },
  INCOME: {
    maxDailyLossPctOfCapital: 0.01,
    maxWeeklyLossPctOfCapital: 0.025,
    maxPositionSizePctOfCapital: 0.06,
    maxPortfolioExposurePct: 50,
    maxSectorExposurePct: 20,
    maxSymbolExposurePct: 10,
    maxOpenPositions: 6,
    maxTradesPerDay: 3,
    maxConsecutiveLosses: 3,
    maxDrawdownPct: 10,
  },
  RETIREMENT: {
    maxDailyLossPctOfCapital: 0.005,
    maxWeeklyLossPctOfCapital: 0.015,
    maxPositionSizePctOfCapital: 0.05,
    maxPortfolioExposurePct: 40,
    maxSectorExposurePct: 15,
    maxSymbolExposurePct: 8,
    maxOpenPositions: 5,
    maxTradesPerDay: 2,
    maxConsecutiveLosses: 2,
    maxDrawdownPct: 8,
  },
};

/**
 * The profile to start a portfolio with.
 *
 * A portfolio with no stated objective gets the day-trading profile — the
 * widest one — because that is what every portfolio created before objectives
 * existed already has, and quietly tightening limits under a running portfolio
 * would change its behaviour without anybody asking for it.
 */
export function riskProfileFor(objective: PortfolioObjective | null | undefined): RiskProfile {
  return objective ? RISK_PROFILES[objective] : RISK_PROFILES[PortfolioObjective.DAY_TRADING];
}

/** How each objective reads on screen, for people who do not think in enums. */
export const OBJECTIVE_LABELS: Record<PortfolioObjective, { title: string; blurb: string }> = {
  DAY_TRADING: {
    title: 'Day trading',
    blurb: 'Bought and sold within days. The widest limits.',
  },
  GROWTH: {
    title: 'Growth',
    blurb: 'Held for years, aiming to be worth more later.',
  },
  INCOME: {
    title: 'Income',
    blurb: 'Held for the dividends it pays rather than the price.',
  },
  RETIREMENT: {
    title: 'Retirement',
    blurb: 'Money that must still be there in decades. The tightest limits.',
  },
};
