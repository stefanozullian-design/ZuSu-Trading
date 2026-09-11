/**
 * Black-Scholes pricing and greeks.
 *
 * Used by the demo/paper option chain generators so that quoted greeks are
 * internally consistent with the quoted premium rather than invented numbers.
 */

/** Abramowitz & Stegun 26.2.17 — |error| < 7.5e-8. */
export function normalCdf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-z * z);
  return 0.5 * (1 + sign * y);
}

export function normalPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

export interface Greeks {
  price: number;
  delta: number;
  gamma: number;
  /** Per calendar day. */
  theta: number;
  /** Per 1 volatility point (1%). */
  vega: number;
}

export interface BlackScholesInput {
  spot: number;
  strike: number;
  /** Time to expiry in years. */
  timeToExpiry: number;
  volatility: number;
  riskFreeRate: number;
  isCall: boolean;
  dividendYield?: number;
}

export function blackScholes(input: BlackScholesInput): Greeks {
  const { spot: S, strike: K, volatility: sigma, riskFreeRate: r, isCall } = input;
  const q = input.dividendYield ?? 0;
  const T = Math.max(input.timeToExpiry, 1 / 365 / 24);

  if (S <= 0 || K <= 0 || sigma <= 0) {
    const intrinsic = Math.max(0, isCall ? S - K : K - S);
    return { price: intrinsic, delta: isCall ? 1 : -1, gamma: 0, theta: 0, vega: 0 };
  }

  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r - q + (sigma * sigma) / 2) * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;
  const discount = Math.exp(-r * T);
  const carry = Math.exp(-q * T);

  const price = isCall
    ? S * carry * normalCdf(d1) - K * discount * normalCdf(d2)
    : K * discount * normalCdf(-d2) - S * carry * normalCdf(-d1);

  const delta = isCall ? carry * normalCdf(d1) : carry * (normalCdf(d1) - 1);
  const gamma = (carry * normalPdf(d1)) / (S * sigma * sqrtT);
  const vega = (S * carry * normalPdf(d1) * sqrtT) / 100;
  const thetaAnnual = isCall
    ? -(S * carry * normalPdf(d1) * sigma) / (2 * sqrtT) -
      r * K * discount * normalCdf(d2) +
      q * S * carry * normalCdf(d1)
    : -(S * carry * normalPdf(d1) * sigma) / (2 * sqrtT) +
      r * K * discount * normalCdf(-d2) -
      q * S * carry * normalCdf(-d1);

  return { price, delta, gamma, vega, theta: thetaAnnual / 365 };
}
