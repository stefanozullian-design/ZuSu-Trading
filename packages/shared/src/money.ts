import Decimal from 'decimal.js';

/**
 * All monetary and quantity arithmetic goes through Decimal. Binary floats are
 * never used for money — a cent lost to rounding is a reconciliation failure.
 */
Decimal.set({ precision: 34, rounding: Decimal.ROUND_HALF_EVEN, toExpNeg: -18, toExpPos: 30 });

export { Decimal };

export type Numeric = Decimal | number | string;

export function dec(value: Numeric | null | undefined): Decimal {
  if (value === null || value === undefined) return new Decimal(0);
  return value instanceof Decimal ? value : new Decimal(value);
}

/** Currency amounts are stored with 2 decimals; prices/quantities with 8. */
export const MONEY_DP = 2;
export const PRICE_DP = 8;
export const QUANTITY_DP = 8;

export function roundMoney(value: Numeric): Decimal {
  return dec(value).toDecimalPlaces(MONEY_DP, Decimal.ROUND_HALF_EVEN);
}

export function roundPrice(value: Numeric): Decimal {
  return dec(value).toDecimalPlaces(PRICE_DP, Decimal.ROUND_HALF_EVEN);
}

export function roundQuantity(value: Numeric): Decimal {
  return dec(value).toDecimalPlaces(QUANTITY_DP, Decimal.ROUND_DOWN);
}

/** Serialised form used across the API boundary — a string, never a float. */
export function toMoneyString(value: Numeric): string {
  return roundMoney(value).toFixed(MONEY_DP);
}

export function formatMoney(value: Numeric, currency = 'USD'): string {
  const d = roundMoney(value);
  const sign = d.isNegative() ? '-' : '';
  const abs = d.abs().toFixed(MONEY_DP);
  const symbol = currency === 'USD' ? '$' : `${currency} `;
  const [whole = '0', frac = '00'] = abs.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}${symbol}${grouped}.${frac}`;
}

export function formatSignedMoney(value: Numeric, currency = 'USD'): string {
  const d = roundMoney(value);
  return `${d.isNegative() ? '' : '+'}${formatMoney(d, currency)}`;
}

export function formatPercent(value: Numeric, dp = 2): string {
  return `${dec(value).toDecimalPlaces(dp, Decimal.ROUND_HALF_EVEN).toFixed(dp)}%`;
}

/**
 * Percentage change guarded against a zero base — returns null rather than
 * Infinity/NaN so callers must decide what "no baseline" means.
 */
export function percentChange(from: Numeric, to: Numeric): Decimal | null {
  const base = dec(from);
  if (base.isZero()) return null;
  return dec(to).minus(base).dividedBy(base.abs()).times(100);
}
