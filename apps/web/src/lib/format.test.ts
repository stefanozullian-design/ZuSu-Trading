import { describe, expect, it } from 'vitest';
import {
  formatMoney,
  formatPercent,
  formatPrice,
  formatQuantity,
  formatSignedMoney,
  pnlTone,
} from './format';

describe('formatting', () => {
  it('shows an em dash for a value the backend could not compute', () => {
    // "Unknown" must never render as $0.00 — that would read as a real number.
    for (const value of [null, undefined, 'not-a-number']) {
      expect(formatMoney(value)).toBe('—');
      expect(formatSignedMoney(value)).toBe('—');
      expect(formatPercent(value)).toBe('—');
      expect(formatPrice(value)).toBe('—');
      expect(formatQuantity(value)).toBe('—');
    }
  });

  it('formats money with grouping and currency', () => {
    expect(formatMoney('1234567.891')).toBe('$1,234,567.89');
    expect(formatMoney('0')).toBe('$0.00');
    expect(formatMoney('-250.5')).toBe('-$250.50');
  });

  it('marks a gain with an explicit plus', () => {
    expect(formatSignedMoney('845')).toBe('+$845.00');
    expect(formatSignedMoney('-845')).toBe('-$845.00');
    expect(formatSignedMoney('0')).toBe('$0.00');
  });

  it('picks a colour only when there is a direction to show', () => {
    expect(pnlTone('10')).toBe('text-profit');
    expect(pnlTone('-10')).toBe('text-loss');
    expect(pnlTone('0')).toBe('text-muted-foreground');
    expect(pnlTone(null)).toBe('text-muted-foreground');
  });

  it('keeps full precision on quantities', () => {
    expect(formatQuantity('0.00000001')).toBe('0.00000001');
    expect(formatQuantity('1000')).toBe('1,000');
  });
});
