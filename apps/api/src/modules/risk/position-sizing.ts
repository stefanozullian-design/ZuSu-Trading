import { Decimal, dec } from '@zusu/shared';

/**
 * Position sizing (§17, §18).
 *
 * Pure arithmetic, deliberately: sizing is the calculation a person most wants
 * to check by hand, and one that reads a database is one nobody checks.
 *
 * The method is fixed-fractional risk. The size follows from the distance to
 * the stop, so a wide stop buys fewer shares and the loss if the stop is hit is
 * the same fraction of equity either way. That is the whole point: without it,
 * position size and risk drift apart and a "1% risk" strategy risks 1% on some
 * trades and 6% on others.
 *
 * Three refusals, each a case where a number could be produced but should not
 * be:
 *
 *   1. **No stop, no size.** Fixed-fractional risk is measured in stop
 *      distance. Without a stop there is no risk to divide by, and falling
 *      back to a notional cap would silently change the method.
 *   2. **A stop on the wrong side is refused**, not flipped. A long with a
 *      stop above the entry is a typo or a bug, and guessing which would size
 *      a position from a misunderstanding.
 *   3. **Whole shares, rounded down.** Rounding up would exceed the risk the
 *      caller asked for, by a little, every time.
 */

export interface SizingInput {
  /** Account equity the fraction is taken from. */
  equity: Decimal;
  /** Fraction of equity to risk, as a percentage. */
  riskPerTradePct: Decimal;
  entryPrice: Decimal;
  stopPrice: Decimal | null;
  direction: 'LONG' | 'SHORT';
  /** Hard cap on the position's notional, from the strategy or the limits. */
  maxNotional: Decimal;
  /** Cash available. A cash account cannot exceed it. */
  availableCash: Decimal;
  /**
   * Optional volatility adjustment: when given, the stop distance is floored
   * at this multiple of ATR, so a stop tighter than the symbol's own noise
   * does not produce an enormous position.
   */
  atr?: Decimal | null;
  minAtrMultiple?: Decimal;
}

export interface SizingResult {
  /** Whole shares. Zero when the trade cannot be sized. */
  quantity: Decimal;
  /** What is actually risked if the stop fills at its price. */
  riskAmount: Decimal;
  riskPerShare: Decimal | null;
  notional: Decimal;
  /** Which constraint decided the size, so a surprising number is explicable. */
  boundBy: 'RISK' | 'MAX_NOTIONAL' | 'CASH' | 'REFUSED';
  reason: string | null;
  /** True when the ATR floor widened the stop distance used for sizing. */
  volatilityFloorApplied: boolean;
}

export function sizePosition(input: SizingInput): SizingResult {
  const refuse = (reason: string): SizingResult => ({
    quantity: dec(0),
    riskAmount: dec(0),
    riskPerShare: null,
    notional: dec(0),
    boundBy: 'REFUSED',
    reason,
    volatilityFloorApplied: false,
  });

  if (input.entryPrice.lessThanOrEqualTo(0)) return refuse('The entry price must be positive.');
  if (input.equity.lessThanOrEqualTo(0)) {
    return refuse('This portfolio has no equity to risk.');
  }
  if (input.riskPerTradePct.lessThanOrEqualTo(0)) {
    return refuse('The risk fraction must be positive.');
  }
  if (!input.stopPrice) {
    return refuse(
      'No stop price, so there is no risk to size against. Fixed-fractional sizing is ' +
        'measured in stop distance, and falling back to a notional cap would change the method ' +
        'without saying so.',
    );
  }

  const long = input.direction === 'LONG';
  const rightSide = long
    ? input.stopPrice.lessThan(input.entryPrice)
    : input.stopPrice.greaterThan(input.entryPrice);
  if (!rightSide) {
    // Flipping it would size a position from a misunderstanding.
    return refuse(
      `A ${input.direction} entry at ${input.entryPrice.toString()} cannot have its stop at ` +
        `${input.stopPrice.toString()}. That is a typo or a bug, not a trade.`,
    );
  }

  let riskPerShare = input.entryPrice.minus(input.stopPrice).abs();
  let volatilityFloorApplied = false;

  const minMultiple = input.minAtrMultiple ?? dec('0.5');
  if (input.atr && input.atr.greaterThan(0) && minMultiple.greaterThan(0)) {
    const floor = input.atr.times(minMultiple);
    if (riskPerShare.lessThan(floor)) {
      // A stop inside the symbol's own noise would be hit by nothing in
      // particular, and dividing by it produces an enormous position.
      riskPerShare = floor;
      volatilityFloorApplied = true;
    }
  }

  if (riskPerShare.lessThanOrEqualTo(0)) {
    return refuse('The stop is at the entry price, so the risk per share is zero.');
  }

  const riskBudget = input.equity.times(input.riskPerTradePct).div(100);
  const byRisk = riskBudget.div(riskPerShare).floor();
  const byNotional = input.maxNotional.div(input.entryPrice).floor();
  const byCash = long ? input.availableCash.div(input.entryPrice).floor() : byNotional;

  const quantity = Decimal.min(byRisk, byNotional, byCash);

  if (quantity.lessThanOrEqualTo(0)) {
    return refuse(
      `A single share costs ${input.entryPrice.toFixed(2)}, which is more than this ` +
        'position may risk or afford.',
    );
  }

  const boundBy: SizingResult['boundBy'] = quantity.equals(byRisk)
    ? 'RISK'
    : quantity.equals(byNotional)
      ? 'MAX_NOTIONAL'
      : 'CASH';

  return {
    quantity,
    riskAmount: riskPerShare.times(quantity),
    riskPerShare,
    notional: input.entryPrice.times(quantity),
    boundBy,
    reason: null,
    volatilityFloorApplied,
  };
}
