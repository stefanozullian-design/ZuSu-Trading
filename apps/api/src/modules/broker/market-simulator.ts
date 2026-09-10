import { MarketSession } from '@zusu/shared';
import { Decimal, dec } from '@zusu/shared';

/**
 * Deterministic synthetic market used by the DEMO environment.
 *
 * The price at any instant is a pure function of (symbol, seed, timestamp), so
 * a demo run is exactly reproducible — which is what makes demo-mode tests
 * meaningful rather than flaky. Nothing here pretends to be real market data:
 * `provider` is reported as `demo-simulator` everywhere it surfaces.
 */

const MINUTE = 60_000;

/** Deterministic 32-bit hash — the seed source for every symbol. */
function hash32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Value noise in [-1, 1], deterministic for a (symbol, bucket, salt) triple. */
function noise(symbol: string, bucket: number, salt: number): number {
  let h = hash32(`${symbol}:${bucket}:${salt}`);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d) >>> 0;
  h ^= h >>> 12;
  return (h / 0xffffffff) * 2 - 1;
}

function smoothStep(t: number): number {
  return t * t * (3 - 2 * t);
}

export interface SimulatedInstrument {
  symbol: string;
  basePrice: number;
  /** Annualised volatility used to scale the walk and the quoted spread. */
  volatility: number;
  averageDailyVolume: number;
}

export interface SimulatorOptions {
  seed?: number;
  /** Injected so tests can drive time explicitly. */
  now?: () => number;
}

/** A small, fixed demo universe. Prices are invented, not sourced. */
export const DEMO_UNIVERSE: SimulatedInstrument[] = [
  { symbol: 'AAPL', basePrice: 187.4, volatility: 0.24, averageDailyVolume: 54_000_000 },
  { symbol: 'MSFT', basePrice: 412.9, volatility: 0.22, averageDailyVolume: 22_000_000 },
  { symbol: 'NVDA', basePrice: 118.6, volatility: 0.48, averageDailyVolume: 310_000_000 },
  { symbol: 'AMD', basePrice: 154.2, volatility: 0.45, averageDailyVolume: 62_000_000 },
  { symbol: 'TSLA', basePrice: 243.1, volatility: 0.52, averageDailyVolume: 98_000_000 },
  { symbol: 'SPY', basePrice: 548.3, volatility: 0.13, averageDailyVolume: 78_000_000 },
  { symbol: 'QQQ', basePrice: 471.8, volatility: 0.18, averageDailyVolume: 45_000_000 },
  { symbol: 'IWM', basePrice: 218.7, volatility: 0.2, averageDailyVolume: 31_000_000 },
];

export class MarketSimulator {
  private readonly seed: number;
  private readonly now: () => number;
  private readonly universe = new Map<string, SimulatedInstrument>();

  constructor(options: SimulatorOptions = {}) {
    this.seed = options.seed ?? 20260101;
    this.now = options.now ?? (() => Date.now());
    for (const instrument of DEMO_UNIVERSE) this.universe.set(instrument.symbol, instrument);
  }

  symbols(): string[] {
    return [...this.universe.keys()];
  }

  currentTime(): Date {
    return new Date(this.now());
  }

  /** Symbols outside the fixed universe get stable synthetic characteristics. */
  instrument(symbol: string): SimulatedInstrument {
    const known = this.universe.get(symbol.toUpperCase());
    if (known) return known;
    const h = hash32(`${symbol}:${this.seed}`);
    return {
      symbol: symbol.toUpperCase(),
      basePrice: 15 + (h % 40_000) / 100,
      volatility: 0.15 + ((h >>> 8) % 45) / 100,
      averageDailyVolume: 250_000 + ((h >>> 16) % 20_000_000),
    };
  }

  /**
   * Mid price at an instant. Continuous in time (adjacent minutes interpolate),
   * so a stop or limit crossing is never an artefact of bucket boundaries.
   */
  priceAt(symbol: string, timestampMs: number = this.now()): Decimal {
    const inst = this.instrument(symbol);
    const key = `${inst.symbol}:${this.seed}`;
    const bucket = Math.floor(timestampMs / MINUTE);
    const frac = (timestampMs % MINUTE) / MINUTE;

    const level = (b: number) => {
      // Three superimposed scales: a session-length swing, an intraday cycle
      // and minute-scale noise, all scaled by the instrument's volatility.
      const daily = Math.sin((2 * Math.PI * b) / 1440 + hash32(key) / 0xffffffff);
      const intraday = Math.sin((2 * Math.PI * b) / 97 + hash32(`${key}:i`) / 0xffffffff);
      const drift = noise(key, Math.floor(b / 390), 3) * 0.6;
      return (
        1 +
        inst.volatility * (0.035 * daily + 0.015 * intraday + 0.02 * drift) +
        inst.volatility * 0.004 * noise(key, b, 1)
      );
    };

    const value = level(bucket) * (1 - smoothStep(frac)) + level(bucket + 1) * smoothStep(frac);
    return dec(inst.basePrice * value).toDecimalPlaces(4, Decimal.ROUND_HALF_EVEN);
  }

  /** Quoted half-spread — wider for volatile names and outside regular hours. */
  spreadAt(symbol: string, timestampMs: number = this.now()): Decimal {
    const inst = this.instrument(symbol);
    const price = this.priceAt(symbol, timestampMs);
    const session = this.sessionAt(new Date(timestampMs));
    const sessionFactor = session === MarketSession.REGULAR ? 1 : 4;
    const bps = (2 + inst.volatility * 8) * sessionFactor;
    return price.times(bps).dividedBy(10_000).toDecimalPlaces(4, Decimal.ROUND_UP);
  }

  /** Cumulative volume traded so far in the current session. */
  volumeAt(symbol: string, timestampMs: number = this.now()): Decimal {
    const inst = this.instrument(symbol);
    const minutesIn = this.minutesIntoSession(new Date(timestampMs));
    const share = Math.max(0, Math.min(1, minutesIn / 390));
    const jitter = 1 + 0.25 * noise(inst.symbol, Math.floor(timestampMs / MINUTE), 7);
    return dec(inst.averageDailyVolume * share * jitter).toDecimalPlaces(0, Decimal.ROUND_DOWN);
  }

  /**
   * Session classification for the simulated venue.
   *
   * This is a US-equity approximation for DEMO only — holidays, early closes,
   * halts and per-symbol availability are the market-calendar engine's job
   * (Phase 2), and this method is replaced by it.
   */
  sessionAt(at: Date = new Date(this.now())): MarketSession {
    const utcDay = at.getUTCDay();
    if (utcDay === 0 || utcDay === 6) return MarketSession.CLOSED;
    const minutes = at.getUTCHours() * 60 + at.getUTCMinutes();
    // 09:30–16:00 America/New_York expressed in UTC (EDT, UTC-4).
    const preOpen = 8 * 60; // 04:00 ET
    const open = 13 * 60 + 30;
    const close = 20 * 60;
    const afterClose = 24 * 60; // 20:00 ET
    if (minutes >= open && minutes < close) return MarketSession.REGULAR;
    if (minutes >= preOpen && minutes < open) return MarketSession.PRE_MARKET;
    if (minutes >= close && minutes < afterClose) return MarketSession.AFTER_HOURS;
    return MarketSession.CLOSED;
  }

  private minutesIntoSession(at: Date): number {
    const minutes = at.getUTCHours() * 60 + at.getUTCMinutes();
    return minutes - (13 * 60 + 30);
  }

  /**
   * Liquidity available to a single order over one second — the basis for
   * partial fills. Proportional to the instrument's typical volume.
   */
  liquidityPerSecond(symbol: string): Decimal {
    const inst = this.instrument(symbol);
    return dec(inst.averageDailyVolume)
      .dividedBy(390 * 60)
      .dividedBy(40)
      .toDecimalPlaces(0, Decimal.ROUND_UP);
  }
}
