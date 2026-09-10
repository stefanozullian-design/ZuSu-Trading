import { describe, expect, it } from 'vitest';
import { TradingEnvironment } from './enums.js';
import {
  ENVIRONMENTS,
  EnvironmentMismatchError,
  assertSameEnvironment,
  isRealMoney,
} from './environment.js';

describe('environment separation', () => {
  it('marks only LIVE as real money and only LIVE as needing confirmation', () => {
    expect(isRealMoney(TradingEnvironment.DEMO)).toBe(false);
    expect(isRealMoney(TradingEnvironment.PAPER)).toBe(false);
    expect(isRealMoney(TradingEnvironment.LIVE)).toBe(true);
    expect(ENVIRONMENTS.LIVE.requiresExplicitConfirmation).toBe(true);
    expect(ENVIRONMENTS.DEMO.requiresExplicitConfirmation).toBe(false);
  });

  it('only lets PAPER and LIVE touch real market data', () => {
    expect(ENVIRONMENTS.DEMO.usesRealMarketData).toBe(false);
    expect(ENVIRONMENTS.PAPER.usesRealMarketData).toBe(true);
    expect(ENVIRONMENTS.PAPER.usesRealBroker).toBe(false);
    expect(ENVIRONMENTS.LIVE.usesRealBroker).toBe(true);
  });

  it('throws when two environments are crossed', () => {
    expect(() =>
      assertSameEnvironment(TradingEnvironment.DEMO, TradingEnvironment.LIVE, 'test'),
    ).toThrow(EnvironmentMismatchError);
    expect(() =>
      assertSameEnvironment(TradingEnvironment.LIVE, TradingEnvironment.LIVE, 'test'),
    ).not.toThrow();
  });
});
