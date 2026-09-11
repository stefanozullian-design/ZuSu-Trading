import { describe, expect, it } from 'vitest';
import { blackScholes, normalCdf } from './black-scholes.js';

describe('black-scholes', () => {
  it('matches the standard normal distribution at known points', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 6);
    expect(normalCdf(1.96)).toBeCloseTo(0.975, 3);
    expect(normalCdf(-1.96)).toBeCloseTo(0.025, 3);
  });

  it('satisfies put-call parity', () => {
    const base = { spot: 100, strike: 95, timeToExpiry: 0.5, volatility: 0.3, riskFreeRate: 0.04 };
    const call = blackScholes({ ...base, isCall: true });
    const put = blackScholes({ ...base, isCall: false });
    // C - P = S - K·e^(-rT)
    const parity = base.spot - base.strike * Math.exp(-base.riskFreeRate * base.timeToExpiry);
    expect(call.price - put.price).toBeCloseTo(parity, 6);
  });

  it('keeps greeks in their theoretical ranges', () => {
    const base = {
      spot: 100,
      strike: 100,
      timeToExpiry: 0.25,
      volatility: 0.4,
      riskFreeRate: 0.04,
    };
    const call = blackScholes({ ...base, isCall: true });
    const put = blackScholes({ ...base, isCall: false });

    expect(call.delta).toBeGreaterThan(0);
    expect(call.delta).toBeLessThan(1);
    expect(put.delta).toBeGreaterThan(-1);
    expect(put.delta).toBeLessThan(0);
    expect(call.gamma).toBeGreaterThan(0);
    expect(call.gamma).toBeCloseTo(put.gamma, 8);
    expect(call.vega).toBeCloseTo(put.vega, 8);
    expect(call.theta).toBeLessThan(0);
  });

  it('falls back to intrinsic value for degenerate inputs', () => {
    const deep = blackScholes({
      spot: 150,
      strike: 100,
      timeToExpiry: 0.0001,
      volatility: 0,
      riskFreeRate: 0.04,
      isCall: true,
    });
    expect(deep.price).toBeCloseTo(50, 6);
  });
});
