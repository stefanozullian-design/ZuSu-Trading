import { Decimal, dec } from '@zusu/shared';
import type { OptionLegRequest, PlaceOptionOrderRequest } from './transport.js';

/**
 * Defined-risk multi-leg options (§80, §86).
 *
 * The rule this module exists to enforce: **if the maximum loss cannot be
 * computed, the order is not placed.** Every structure below is one whose
 * worst case is arithmetic rather than an opinion, and the builder refuses
 * anything else — a naked short call has an unbounded loss, and no amount of
 * confidence makes that a defined risk.
 *
 * Robinhood's contract supports one to four legs filled together as a single
 * strategy, with a net debit or credit and a net limit price. That is exactly
 * what a spread needs, so the builder produces that shape directly rather than
 * legging in, which would leave a half-built position if the second leg missed.
 */

export interface OptionContractRef {
  optionId: string;
  strike: Decimal;
  isCall: boolean;
  /** ISO date. Legs of a vertical must share it; a calendar must not. */
  expiration: string;
}

export interface DefinedRiskQuote {
  /** Net premium of the whole strategy, always positive. */
  netPrice: Decimal;
  direction: 'debit' | 'credit';
}

export interface DefinedRiskPlan {
  strategy: 'VERTICAL' | 'IRON_CONDOR';
  legs: OptionLegRequest[];
  /** The most this position can lose, per contract, before fees. */
  maxLoss: Decimal;
  /** The most it can make, per contract. */
  maxProfit: Decimal;
  /** Plain words, for the person approving it. */
  description: string;
}

export class UndefinedRiskError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UndefinedRiskError';
  }
}

/**
 * A vertical spread: two legs, same expiration, different strikes.
 *
 * Maximum loss is the width of the strikes minus the credit received (or the
 * debit paid, for a debit spread). Both are known before the order is placed,
 * which is what makes it defined-risk.
 */
export function buildVertical(input: {
  long: OptionContractRef;
  short: OptionContractRef;
  quote: DefinedRiskQuote;
  positionEffect?: 'open' | 'close';
}): DefinedRiskPlan {
  const { long, short, quote } = input;

  if (long.isCall !== short.isCall) {
    throw new UndefinedRiskError(
      'A vertical spread needs both legs on the same side — two calls or two puts. ' +
        'Mixing them is a different structure with a different worst case.',
    );
  }
  if (long.expiration !== short.expiration) {
    throw new UndefinedRiskError(
      'A vertical spread needs both legs at the same expiration. Different expirations make ' +
        'a calendar, whose maximum loss is not the strike width.',
    );
  }
  if (long.strike.equals(short.strike)) {
    throw new UndefinedRiskError('Both legs are at the same strike, so there is no spread.');
  }
  if (quote.netPrice.lessThanOrEqualTo(0)) {
    throw new UndefinedRiskError('The net premium must be positive; direction says which way.');
  }

  const width = long.strike.minus(short.strike).abs();
  if (quote.direction === 'credit' && quote.netPrice.greaterThanOrEqualTo(width)) {
    // A credit larger than the width would mean a risk-free trade, which means
    // the quote is wrong.
    throw new UndefinedRiskError(
      `A credit of ${quote.netPrice.toString()} on a ${width.toString()}-wide spread is not a ` +
        'price that exists. Check the quote before sending it.',
    );
  }

  const maxLoss = quote.direction === 'credit' ? width.minus(quote.netPrice) : quote.netPrice;
  const maxProfit = quote.direction === 'credit' ? quote.netPrice : width.minus(quote.netPrice);

  const effect = input.positionEffect ?? 'open';
  return {
    strategy: 'VERTICAL',
    legs: [
      { option_id: long.optionId, side: 'buy', position_effect: effect, ratio_quantity: 1 },
      { option_id: short.optionId, side: 'sell', position_effect: effect, ratio_quantity: 1 },
    ],
    maxLoss,
    maxProfit,
    description:
      `${quote.direction === 'credit' ? 'Credit' : 'Debit'} ${long.isCall ? 'call' : 'put'} ` +
      `vertical, ${width.toString()} wide, expiring ${long.expiration}. ` +
      `Most it can lose: ${maxLoss.toString()} per contract. Most it can make: ` +
      `${maxProfit.toString()}.`,
  };
}

/**
 * An iron condor: a put spread and a call spread, same expiration.
 *
 * The maximum loss is the wider of the two spreads minus the net credit. Both
 * wings must exist — a "condor" missing one is a naked short, and the builder
 * refuses it by requiring four legs rather than trusting the caller.
 */
export function buildIronCondor(input: {
  longPut: OptionContractRef;
  shortPut: OptionContractRef;
  shortCall: OptionContractRef;
  longCall: OptionContractRef;
  quote: DefinedRiskQuote;
}): DefinedRiskPlan {
  const { longPut, shortPut, shortCall, longCall, quote } = input;

  const expirations = new Set([
    longPut.expiration,
    shortPut.expiration,
    shortCall.expiration,
    longCall.expiration,
  ]);
  if (expirations.size !== 1) {
    throw new UndefinedRiskError('Every leg of an iron condor shares one expiration.');
  }
  if (longPut.isCall || shortPut.isCall || !shortCall.isCall || !longCall.isCall) {
    throw new UndefinedRiskError(
      'An iron condor is a put spread below and a call spread above; the legs given are not ' +
        'that shape.',
    );
  }
  if (quote.direction !== 'credit') {
    throw new UndefinedRiskError('An iron condor is opened for a credit.');
  }
  if (!longPut.strike.lessThan(shortPut.strike)) {
    throw new UndefinedRiskError(
      'The long put must be below the short put, or the put wing is naked.',
    );
  }
  if (!longCall.strike.greaterThan(shortCall.strike)) {
    throw new UndefinedRiskError(
      'The long call must be above the short call, or the call wing is naked — an unbounded loss.',
    );
  }

  const putWidth = shortPut.strike.minus(longPut.strike);
  const callWidth = longCall.strike.minus(shortCall.strike);
  const widest = Decimal.max(putWidth, callWidth);

  if (quote.netPrice.greaterThanOrEqualTo(widest)) {
    throw new UndefinedRiskError(
      `A credit of ${quote.netPrice.toString()} against a widest wing of ${widest.toString()} ` +
        'is not a price that exists.',
    );
  }

  return {
    strategy: 'IRON_CONDOR',
    legs: [
      { option_id: longPut.optionId, side: 'buy', position_effect: 'open', ratio_quantity: 1 },
      { option_id: shortPut.optionId, side: 'sell', position_effect: 'open', ratio_quantity: 1 },
      { option_id: shortCall.optionId, side: 'sell', position_effect: 'open', ratio_quantity: 1 },
      { option_id: longCall.optionId, side: 'buy', position_effect: 'open', ratio_quantity: 1 },
    ],
    maxLoss: widest.minus(quote.netPrice),
    maxProfit: quote.netPrice,
    description:
      `Iron condor expiring ${longPut.expiration}: put wing ${putWidth.toString()} wide, call ` +
      `wing ${callWidth.toString()} wide, for a ${quote.netPrice.toString()} credit. Most it can ` +
      `lose: ${widest.minus(quote.netPrice).toString()} per contract.`,
  };
}

/**
 * Turns a plan into the order the broker expects.
 *
 * Limit only, because multi-leg is limit-only at the broker and because a
 * market order on a four-leg spread is a way to pay whatever the book asks.
 */
export function toOrderRequest(input: {
  plan: DefinedRiskPlan;
  accountNumber: string;
  quantity: number;
  quote: DefinedRiskQuote;
  idempotencyKey: string;
  timeInForce?: 'gfd' | 'gtc';
}): PlaceOptionOrderRequest {
  if (!Number.isInteger(input.quantity) || input.quantity < 1) {
    throw new UndefinedRiskError('Contract count must be a positive whole number.');
  }

  return {
    account_number: input.accountNumber,
    legs: input.plan.legs,
    quantity: String(input.quantity),
    price: input.quote.netPrice.toString(),
    direction: input.quote.direction,
    type: 'limit',
    time_in_force: input.timeInForce ?? 'gfd',
    ref_id: input.idempotencyKey,
  };
}

/** The most a plan can lose in total, for a risk check before approval. */
export function totalMaxLoss(plan: DefinedRiskPlan, contracts: number): Decimal {
  // A contract is a hundred shares, so the per-contract figure is multiplied
  // twice — the mistake that makes a "small" spread a large loss.
  return plan.maxLoss.times(contracts).times(dec(100));
}
