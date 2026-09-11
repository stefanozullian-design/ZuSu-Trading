import { describe, expect, it } from 'vitest';
import {
  dec,
  formatMoney,
  formatSignedMoney,
  percentChange,
  roundMoney,
  toMoneyString,
} from './money.js';

describe('money', () => {
  it('keeps precision that binary floats would lose', () => {
    // 0.1 + 0.2 === 0.30000000000000004 in IEEE-754.
    expect(dec('0.1').plus('0.2').toString()).toBe('0.3');
    expect(toMoneyString(dec('1234.005'))).toBe('1234.00');
  });

  it('rounds half to even so repeated rounding does not drift upward', () => {
    expect(roundMoney('2.345').toFixed(2)).toBe('2.34');
    expect(roundMoney('2.355').toFixed(2)).toBe('2.36');
  });

  it('formats money with grouping and an explicit sign where useful', () => {
    expect(formatMoney('1234567.891')).toBe('$1,234,567.89');
    expect(formatMoney('-42')).toBe('-$42.00');
    expect(formatSignedMoney('42')).toBe('+$42.00');
    expect(formatSignedMoney('-42')).toBe('-$42.00');
  });

  it('returns null rather than Infinity when the baseline is zero', () => {
    expect(percentChange(0, 100)).toBeNull();
    expect(percentChange(100, 110)?.toFixed(2)).toBe('10.00');
    // A negative baseline still yields a signed change against its magnitude.
    expect(percentChange(-100, -90)?.toFixed(2)).toBe('10.00');
  });
});
