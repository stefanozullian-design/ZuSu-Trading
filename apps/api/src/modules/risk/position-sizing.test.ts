import { dec } from '@zusu/shared';
import { describe, expect, it } from 'vitest';
import { sizePosition, type SizingInput } from './position-sizing.js';

/**
 * Position sizing.
 *
 * The arithmetic is simple enough to check by hand, which is the point: these
 * tests write out the numbers rather than asserting that the function agrees
 * with itself.
 */

function input(overrides: Partial<SizingInput> = {}): SizingInput {
  return {
    equity: dec('100000'),
    riskPerTradePct: dec('1'),
    entryPrice: dec('100'),
    stopPrice: dec('98'),
    direction: 'LONG',
    maxNotional: dec('1000000'),
    availableCash: dec('1000000'),
    ...overrides,
  };
}

describe('fixed-fractional sizing', () => {
  it('sizes from the distance to the stop', () => {
    // 1% of 100,000 is 1,000 of risk; the stop is 2 away, so 500 shares.
    const result = sizePosition(input());

    expect(result.quantity.toString()).toBe('500');
    expect(result.riskAmount.toString()).toBe('1000');
    expect(result.boundBy).toBe('RISK');
  });

  it('buys fewer shares when the stop is wider, for the same risk', () => {
    const tight = sizePosition(input({ stopPrice: dec('99') }));
    const wide = sizePosition(input({ stopPrice: dec('90') }));

    expect(tight.quantity.toString()).toBe('1000');
    expect(wide.quantity.toString()).toBe('100');
    // The whole point: the loss if the stop is hit is the same either way.
    expect(tight.riskAmount.toString()).toBe(wide.riskAmount.toString());
  });

  it('sizes a short symmetrically', () => {
    const result = sizePosition(
      input({ direction: 'SHORT', entryPrice: dec('100'), stopPrice: dec('102') }),
    );

    expect(result.quantity.toString()).toBe('500');
  });

  it('rounds down to whole shares', () => {
    // 1% of 10,000 is 100 of risk over a stop 3 away: 33.33 shares.
    const result = sizePosition(input({ equity: dec('10000'), stopPrice: dec('97') }));

    // Rounding up would exceed the risk asked for, by a little, every time.
    expect(result.quantity.toString()).toBe('33');
    expect(Number(result.riskAmount.toString())).toBeLessThanOrEqual(100);
  });
});

describe('the caps', () => {
  it('respects the notional cap and says that is what bound it', () => {
    const result = sizePosition(input({ maxNotional: dec('10000') }));

    expect(result.quantity.toString()).toBe('100');
    expect(result.boundBy).toBe('MAX_NOTIONAL');
  });

  it('respects available cash on a long', () => {
    const result = sizePosition(input({ availableCash: dec('2500') }));

    expect(result.quantity.toString()).toBe('25');
    expect(result.boundBy).toBe('CASH');
  });
});

describe('what it refuses', () => {
  it('refuses to size without a stop, rather than falling back to a cap', () => {
    const result = sizePosition(input({ stopPrice: null }));

    // Falling back would silently change the method from risk-based to
    // notional-based, and the reported risk would then be fiction.
    expect(result.quantity.toString()).toBe('0');
    expect(result.boundBy).toBe('REFUSED');
    expect(result.reason).toContain('no risk to size against');
  });

  it('refuses a stop on the wrong side instead of flipping it', () => {
    const long = sizePosition(input({ stopPrice: dec('105') }));
    const short = sizePosition(
      input({ direction: 'SHORT', entryPrice: dec('100'), stopPrice: dec('95') }),
    );

    expect(long.reason).toContain('typo or a bug');
    expect(short.reason).toContain('typo or a bug');
  });

  it('refuses a stop at the entry price', () => {
    const result = sizePosition(input({ stopPrice: dec('100') }));
    expect(result.reason).toContain('typo or a bug');
  });

  it('refuses when a single share is unaffordable', () => {
    const result = sizePosition(
      input({ entryPrice: dec('5000'), stopPrice: dec('4900'), availableCash: dec('100') }),
    );

    expect(result.quantity.toString()).toBe('0');
    expect(result.reason).toContain('more than this position may risk or afford');
  });

  it('refuses a portfolio with no equity', () => {
    const result = sizePosition(input({ equity: dec('0') }));
    expect(result.reason).toContain('no equity to risk');
  });
});

describe('the volatility floor', () => {
  it('widens a stop tighter than the symbol’s own noise', () => {
    // The stop is 0.1 away, but half an ATR is 0.5, so 0.5 is used.
    const result = sizePosition(
      input({ stopPrice: dec('99.9'), atr: dec('1'), minAtrMultiple: dec('0.5') }),
    );

    expect(result.volatilityFloorApplied).toBe(true);
    // 1,000 of risk over 0.5 is 2,000 shares — not the 10,000 the raw stop
    // distance would have produced.
    expect(result.quantity.toString()).toBe('2000');
  });

  it('leaves a stop wider than the floor alone', () => {
    const result = sizePosition(input({ stopPrice: dec('98'), atr: dec('1') }));

    expect(result.volatilityFloorApplied).toBe(false);
    expect(result.quantity.toString()).toBe('500');
  });

  it('ignores an absent or zero ATR rather than treating it as a floor of zero', () => {
    const absent = sizePosition(input({ atr: null }));
    const zero = sizePosition(input({ atr: dec('0') }));

    expect(absent.quantity.toString()).toBe('500');
    expect(zero.quantity.toString()).toBe('500');
  });
});
