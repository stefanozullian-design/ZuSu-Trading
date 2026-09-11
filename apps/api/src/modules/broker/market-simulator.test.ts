import { describe, expect, it } from 'vitest';
import { MarketSession } from '@zusu/shared';
import { MarketSimulator } from './market-simulator.js';

const WEDNESDAY_1500_UTC = Date.UTC(2026, 8, 9, 15, 0, 0);

describe('MarketSimulator', () => {
  it('is deterministic for a given seed and instant', () => {
    const a = new MarketSimulator({ seed: 99 });
    const b = new MarketSimulator({ seed: 99 });
    for (const symbol of ['AAPL', 'NVDA', 'ZZZZ']) {
      expect(a.priceAt(symbol, WEDNESDAY_1500_UTC).toString()).toBe(
        b.priceAt(symbol, WEDNESDAY_1500_UTC).toString(),
      );
    }
  });

  it('produces a different path for a different seed', () => {
    const a = new MarketSimulator({ seed: 1 });
    const b = new MarketSimulator({ seed: 2 });
    expect(a.priceAt('AAPL', WEDNESDAY_1500_UTC).toString()).not.toBe(
      b.priceAt('AAPL', WEDNESDAY_1500_UTC).toString(),
    );
  });

  it('moves continuously — no jumps at minute boundaries', () => {
    const sim = new MarketSimulator({ seed: 7 });
    const before = sim.priceAt('AAPL', WEDNESDAY_1500_UTC - 1).toNumber();
    const after = sim.priceAt('AAPL', WEDNESDAY_1500_UTC + 1).toNumber();
    expect(Math.abs(after - before) / before).toBeLessThan(0.001);
  });

  it('always quotes a positive price and a positive spread', () => {
    const sim = new MarketSimulator({ seed: 3 });
    for (let minute = 0; minute < 400; minute += 7) {
      const at = WEDNESDAY_1500_UTC + minute * 60_000;
      expect(sim.priceAt('TSLA', at).toNumber()).toBeGreaterThan(0);
      expect(sim.spreadAt('TSLA', at).toNumber()).toBeGreaterThan(0);
    }
  });

  it('classifies the trading session', () => {
    const sim = new MarketSimulator({ seed: 3 });
    expect(sim.sessionAt(new Date(WEDNESDAY_1500_UTC))).toBe(MarketSession.REGULAR);
    // 11:00 UTC is 07:00 New York — pre-market.
    expect(sim.sessionAt(new Date(Date.UTC(2026, 8, 9, 11, 0)))).toBe(MarketSession.PRE_MARKET);
    // 21:00 UTC is 17:00 New York — after hours.
    expect(sim.sessionAt(new Date(Date.UTC(2026, 8, 9, 21, 0)))).toBe(MarketSession.AFTER_HOURS);
    // Saturday.
    expect(sim.sessionAt(new Date(Date.UTC(2026, 8, 12, 15, 0)))).toBe(MarketSession.CLOSED);
  });

  it('gives unknown symbols stable synthetic characteristics', () => {
    const sim = new MarketSimulator({ seed: 11 });
    const first = sim.instrument('WIDGET');
    const second = sim.instrument('WIDGET');
    expect(first).toEqual(second);
    expect(first.basePrice).toBeGreaterThan(0);
  });
});
