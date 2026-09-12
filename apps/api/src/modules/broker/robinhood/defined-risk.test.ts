import { dec } from '@zusu/shared';
import { describe, expect, it } from 'vitest';
import {
  UndefinedRiskError,
  buildIronCondor,
  buildVertical,
  toOrderRequest,
  totalMaxLoss,
  type OptionContractRef,
} from './defined-risk.js';

/**
 * Defined-risk options structures.
 *
 * Every test here is about the same rule: if the maximum loss cannot be
 * computed, there is no order. The refusals are the point — a naked wing, a
 * mismatched expiration, a credit larger than the spread is wide.
 */

const contract = (overrides: Partial<OptionContractRef> = {}): OptionContractRef => ({
  optionId: 'opt-1',
  strike: dec('100'),
  isCall: true,
  expiration: '2026-10-16',
  ...overrides,
});

describe('vertical spreads', () => {
  it('computes the worst case of a credit spread from the strike width', () => {
    const plan = buildVertical({
      short: contract({ optionId: 'short', strike: dec('100') }),
      long: contract({ optionId: 'long', strike: dec('105') }),
      quote: { netPrice: dec('1.50'), direction: 'credit' },
    });

    // Five wide, 1.50 collected: 3.50 at risk, 1.50 to make.
    expect(plan.maxLoss.toString()).toBe('3.5');
    expect(plan.maxProfit.toString()).toBe('1.5');
    expect(plan.legs).toHaveLength(2);
  });

  it('computes the worst case of a debit spread as the premium paid', () => {
    const plan = buildVertical({
      long: contract({ optionId: 'long', strike: dec('100') }),
      short: contract({ optionId: 'short', strike: dec('105') }),
      quote: { netPrice: dec('2'), direction: 'debit' },
    });

    expect(plan.maxLoss.toString()).toBe('2');
    expect(plan.maxProfit.toString()).toBe('3');
  });

  it('describes the position in words, for the person approving it', () => {
    const plan = buildVertical({
      short: contract({ optionId: 'short', strike: dec('100') }),
      long: contract({ optionId: 'long', strike: dec('105') }),
      quote: { netPrice: dec('1.50'), direction: 'credit' },
    });

    expect(plan.description).toContain('Most it can lose: 3.5 per contract');
  });

  it('refuses legs at different expirations', () => {
    expect(() =>
      buildVertical({
        long: contract({ expiration: '2026-10-16' }),
        short: contract({ strike: dec('105'), expiration: '2026-11-20' }),
        quote: { netPrice: dec('1'), direction: 'debit' },
      }),
    ).toThrow(/same expiration/);
  });

  it('refuses a call against a put', () => {
    expect(() =>
      buildVertical({
        long: contract({ isCall: true }),
        short: contract({ strike: dec('95'), isCall: false }),
        quote: { netPrice: dec('1'), direction: 'debit' },
      }),
    ).toThrow(/same side/);
  });

  it('refuses a credit larger than the spread is wide', () => {
    // That would be a risk-free trade, which means the quote is wrong.
    expect(() =>
      buildVertical({
        short: contract({ strike: dec('100') }),
        long: contract({ strike: dec('105') }),
        quote: { netPrice: dec('6'), direction: 'credit' },
      }),
    ).toThrow(UndefinedRiskError);
  });

  it('refuses two legs at the same strike', () => {
    expect(() =>
      buildVertical({
        long: contract({ strike: dec('100') }),
        short: contract({ strike: dec('100') }),
        quote: { netPrice: dec('1'), direction: 'debit' },
      }),
    ).toThrow(/no spread/);
  });
});

describe('iron condors', () => {
  const wings = {
    longPut: contract({ optionId: 'lp', strike: dec('90'), isCall: false }),
    shortPut: contract({ optionId: 'sp', strike: dec('95'), isCall: false }),
    shortCall: contract({ optionId: 'sc', strike: dec('110'), isCall: true }),
    longCall: contract({ optionId: 'lc', strike: dec('115'), isCall: true }),
  };

  it('computes the worst case as the widest wing less the credit', () => {
    const plan = buildIronCondor({ ...wings, quote: { netPrice: dec('2'), direction: 'credit' } });

    expect(plan.legs).toHaveLength(4);
    expect(plan.maxLoss.toString()).toBe('3');
    expect(plan.maxProfit.toString()).toBe('2');
  });

  it('refuses a naked call wing', () => {
    expect(() =>
      buildIronCondor({
        ...wings,
        // The long call below the short one leaves the upside unbounded.
        longCall: contract({ optionId: 'lc', strike: dec('105'), isCall: true }),
        quote: { netPrice: dec('2'), direction: 'credit' },
      }),
    ).toThrow(/unbounded loss/);
  });

  it('refuses a naked put wing', () => {
    expect(() =>
      buildIronCondor({
        ...wings,
        longPut: contract({ optionId: 'lp', strike: dec('97'), isCall: false }),
        quote: { netPrice: dec('2'), direction: 'credit' },
      }),
    ).toThrow(/naked/);
  });

  it('refuses mixed expirations', () => {
    expect(() =>
      buildIronCondor({
        ...wings,
        longCall: contract({ optionId: 'lc', strike: dec('115'), expiration: '2026-11-20' }),
        quote: { netPrice: dec('2'), direction: 'credit' },
      }),
    ).toThrow(/one expiration/);
  });

  it('refuses a debit: an iron condor is opened for a credit', () => {
    expect(() =>
      buildIronCondor({ ...wings, quote: { netPrice: dec('2'), direction: 'debit' } }),
    ).toThrow(/for a credit/);
  });
});

describe('turning a plan into an order', () => {
  const plan = buildVertical({
    short: contract({ optionId: 'short', strike: dec('100') }),
    long: contract({ optionId: 'long', strike: dec('105') }),
    quote: { netPrice: dec('1.50'), direction: 'credit' },
  });

  it('sends every leg as one strategy, at a net limit price', () => {
    const request = toOrderRequest({
      plan,
      accountNumber: 'RH-1',
      quantity: 3,
      quote: { netPrice: dec('1.50'), direction: 'credit' },
      idempotencyKey: 'our-key',
    });

    expect(request.legs).toHaveLength(2);
    expect(request.quantity).toBe('3');
    expect(request.price).toBe('1.5');
    expect(request.direction).toBe('credit');
    // Limit only: a market order on a spread is a way to pay whatever the
    // book asks.
    expect(request.type).toBe('limit');
    expect(request.ref_id).toBe('our-key');
  });

  it('refuses a fractional contract count', () => {
    expect(() =>
      toOrderRequest({
        plan,
        accountNumber: 'RH-1',
        quantity: 1.5,
        quote: { netPrice: dec('1.50'), direction: 'credit' },
        idempotencyKey: 'k',
      }),
    ).toThrow(/whole number/);
  });

  it('multiplies the worst case by a hundred, because a contract is a hundred shares', () => {
    // The mistake that turns a "small" spread into a large loss.
    expect(totalMaxLoss(plan, 3).toString()).toBe('1050');
  });
});
