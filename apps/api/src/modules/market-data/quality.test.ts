import { dec } from '@zusu/shared';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_THRESHOLDS,
  DataQualityIssue,
  inspectCandles,
  inspectQuote,
  providerOutageFinding,
} from './quality.js';
import type { ProviderCandle, ProviderQuote, Timeframe } from './types.js';

const SOURCE = new Date('2026-09-11T14:30:00.000Z');

function quote(overrides: Partial<ProviderQuote> = {}): ProviderQuote {
  return {
    symbol: 'AAPL',
    provider: 'massive',
    price: dec('100'),
    bid: dec('99.99'),
    ask: dec('100.01'),
    bidSize: dec('200'),
    askSize: dec('300'),
    volume: dec('1000000'),
    sourceTimestamp: SOURCE,
    receivedTimestamp: new Date(SOURCE.getTime() + 250),
    marketSession: null,
    ...overrides,
  };
}

function candle(openTime: string, overrides: Partial<ProviderCandle> = {}): ProviderCandle {
  const open = new Date(openTime);
  const timeframe: Timeframe = overrides.timeframe ?? '1m';
  return {
    symbol: 'AAPL',
    timeframe,
    openTime: open,
    closeTime: new Date(open.getTime() + 60_000),
    open: dec('100'),
    high: dec('101'),
    low: dec('99'),
    close: dec('100.5'),
    volume: dec('5000'),
    vwap: dec('100.2'),
    tradeCount: 42,
    isAdjusted: true,
    ...overrides,
  };
}

const issues = (findings: { issue: string }[]) => findings.map((f) => f.issue);

describe('inspectQuote — a healthy quote', () => {
  it('returns the price and finds nothing', () => {
    const result = inspectQuote(quote());
    expect(result.findings).toEqual([]);
    expect(result.usablePrice?.toString()).toBe('100');
  });

  it('does not invent a jump when there is no reference price', () => {
    // The first quote for a symbol has nothing to jump from.
    const result = inspectQuote(quote({ price: dec('5000') }));
    expect(result.findings).toEqual([]);
  });
});

describe('inspectQuote — staleness', () => {
  it('accepts a quote exactly at the age limit', () => {
    const result = inspectQuote(
      quote({ receivedTimestamp: new Date(SOURCE.getTime() + DEFAULT_THRESHOLDS.maxQuoteAgeMs) }),
    );
    expect(result.findings).toEqual([]);
  });

  it('flags a quote one millisecond over the limit', () => {
    const result = inspectQuote(
      quote({
        receivedTimestamp: new Date(SOURCE.getTime() + DEFAULT_THRESHOLDS.maxQuoteAgeMs + 1),
      }),
    );
    expect(issues(result.findings)).toEqual([DataQualityIssue.STALE_QUOTE]);
    expect(result.findings[0].blocking).toBe(true);
    expect(result.usablePrice).toBeNull();
  });

  it('honours an overridden threshold', () => {
    const stale = quote({ receivedTimestamp: new Date(SOURCE.getTime() + 10_000) });
    expect(inspectQuote(stale, { thresholds: { maxQuoteAgeMs: 30_000 } }).findings).toEqual([]);
  });

  it('flags a source timestamp in our future as a clock disagreement', () => {
    const result = inspectQuote(quote({ receivedTimestamp: new Date(SOURCE.getTime() - 5_000) }));
    // Every staleness verdict computed from disagreeing clocks is meaningless.
    expect(issues(result.findings)).toContain(DataQualityIssue.TIMESTAMP_GAP);
    expect(result.usablePrice).toBeNull();
  });

  it('tolerates sub-second clock skew without complaint', () => {
    const result = inspectQuote(quote({ receivedTimestamp: new Date(SOURCE.getTime() - 200) }));
    expect(result.findings).toEqual([]);
  });
});

describe('inspectQuote — impossible prices', () => {
  it('flags a zero price', () => {
    const result = inspectQuote(quote({ price: dec('0') }));
    expect(issues(result.findings)).toContain(DataQualityIssue.NON_POSITIVE_PRICE);
    expect(result.usablePrice).toBeNull();
  });

  it('flags a negative bid', () => {
    const result = inspectQuote(quote({ bid: dec('-1') }));
    expect(issues(result.findings)).toContain(DataQualityIssue.NON_POSITIVE_PRICE);
  });

  it('treats an absent bid as absent, not as zero', () => {
    const result = inspectQuote(quote({ bid: null, ask: null }));
    expect(result.findings).toEqual([]);
    expect(result.usablePrice?.toString()).toBe('100');
  });

  it('names the offending field in the detail', () => {
    const result = inspectQuote(quote({ ask: dec('0') }));
    expect(result.findings[0].detail).toContain('ask is 0');
  });
});

describe('inspectQuote — spreads', () => {
  it('flags a crossed book', () => {
    const result = inspectQuote(quote({ bid: dec('101'), ask: dec('100') }));
    expect(issues(result.findings)).toEqual([DataQualityIssue.IMPOSSIBLE_SPREAD]);
    expect(result.findings[0].detail).toContain('crossed');
  });

  it('accepts a spread exactly at the limit', () => {
    // midpoint 100, spread 5 → exactly 5%
    const result = inspectQuote(quote({ bid: dec('97.5'), ask: dec('102.5') }));
    expect(result.findings).toEqual([]);
  });

  it('flags a spread over the limit', () => {
    const result = inspectQuote(quote({ bid: dec('95'), ask: dec('105') }));
    expect(issues(result.findings)).toEqual([DataQualityIssue.IMPOSSIBLE_SPREAD]);
    expect(result.findings[0].detail).toContain('10.00%');
  });

  it('does not judge a spread when one side is missing', () => {
    expect(inspectQuote(quote({ bid: null })).findings).toEqual([]);
  });
});

describe('inspectQuote — abnormal jumps', () => {
  it('accepts a move exactly at the limit', () => {
    const result = inspectQuote(quote({ price: dec('120') }), { referencePrice: dec('100') });
    expect(result.findings).toEqual([]);
  });

  it('flags a move over the limit in either direction', () => {
    const up = inspectQuote(quote({ price: dec('121') }), { referencePrice: dec('100') });
    expect(issues(up.findings)).toEqual([DataQualityIssue.ABNORMAL_JUMP]);

    const down = inspectQuote(quote({ price: dec('79') }), { referencePrice: dec('100') });
    expect(issues(down.findings)).toEqual([DataQualityIssue.ABNORMAL_JUMP]);
  });

  it('reports the move and both prices so the finding is explainable', () => {
    const result = inspectQuote(quote({ price: dec('200') }), { referencePrice: dec('100') });
    expect(result.findings[0].detail).toMatch(/100\.00%/);
    expect(result.findings[0].detail).toContain('100');
    expect(result.findings[0].detail).toContain('200');
  });

  it('ignores a non-positive reference price', () => {
    expect(inspectQuote(quote(), { referencePrice: dec('0') }).findings).toEqual([]);
  });
});

describe('inspectQuote — multiple faults', () => {
  it('reports every fault rather than stopping at the first', () => {
    const result = inspectQuote(
      quote({
        price: dec('-5'),
        bid: dec('101'),
        ask: dec('100'),
        receivedTimestamp: new Date(SOURCE.getTime() + 60_000),
      }),
    );
    expect(issues(result.findings)).toEqual(
      expect.arrayContaining([
        DataQualityIssue.STALE_QUOTE,
        DataQualityIssue.NON_POSITIVE_PRICE,
        DataQualityIssue.IMPOSSIBLE_SPREAD,
      ]),
    );
    expect(result.usablePrice).toBeNull();
  });
});

describe('inspectCandles — coherence', () => {
  it('accepts a clean series', () => {
    const result = inspectCandles([candle('2026-09-11T14:30:00Z'), candle('2026-09-11T14:31:00Z')]);
    expect(result.findings).toEqual([]);
    expect(result.usable).toHaveLength(2);
  });

  it('handles an empty series without inventing findings', () => {
    expect(inspectCandles([])).toEqual({ usable: [], findings: [] });
  });

  it('drops a bar whose high is below its low', () => {
    const result = inspectCandles([
      candle('2026-09-11T14:30:00Z'),
      candle('2026-09-11T14:31:00Z', { high: dec('98'), low: dec('99') }),
    ]);
    expect(issues(result.findings)).toEqual([DataQualityIssue.IMPOSSIBLE_SPREAD]);
    expect(result.usable).toHaveLength(1);
  });

  it('drops a bar whose close sits outside its range', () => {
    const result = inspectCandles([candle('2026-09-11T14:30:00Z', { close: dec('105') })]);
    expect(issues(result.findings)).toEqual([DataQualityIssue.IMPOSSIBLE_SPREAD]);
    expect(result.findings[0].detail).toContain('outside the high/low range');
    expect(result.usable).toEqual([]);
  });

  it('drops a bar with a non-positive price', () => {
    const result = inspectCandles([candle('2026-09-11T14:30:00Z', { low: dec('0') })]);
    expect(issues(result.findings)).toEqual([DataQualityIssue.NON_POSITIVE_PRICE]);
    expect(result.usable).toEqual([]);
  });

  it('drops a bar with negative volume', () => {
    const result = inspectCandles([candle('2026-09-11T14:30:00Z', { volume: dec('-1') })]);
    expect(issues(result.findings)).toEqual([DataQualityIssue.NON_POSITIVE_PRICE]);
  });

  it('keeps the good bars when only one is bad', () => {
    const result = inspectCandles([
      candle('2026-09-11T14:30:00Z'),
      candle('2026-09-11T14:31:00Z', { high: dec('1'), low: dec('2') }),
      candle('2026-09-11T14:32:00Z'),
    ]);
    // One impossible bar does not invalidate the rest of the series.
    expect(result.usable.map((c) => c.openTime.toISOString())).toEqual([
      '2026-09-11T14:30:00.000Z',
      '2026-09-11T14:32:00.000Z',
    ]);
  });
});

describe('inspectCandles — duplicates', () => {
  it('de-duplicates an identical repeat without blocking', () => {
    const result = inspectCandles([candle('2026-09-11T14:30:00Z'), candle('2026-09-11T14:30:00Z')]);
    expect(issues(result.findings)).toEqual([DataQualityIssue.DUPLICATE]);
    expect(result.findings[0].blocking).toBe(false);
    expect(result.usable).toHaveLength(1);
  });

  it('blocks on a repeat that disagrees with itself', () => {
    const result = inspectCandles([
      candle('2026-09-11T14:30:00Z'),
      candle('2026-09-11T14:30:00Z', { close: dec('100.75') }),
    ]);
    // Nothing here can tell which of the two is true.
    expect(result.findings[0].blocking).toBe(true);
    expect(result.findings[0].detail).toContain('different values');
    expect(result.usable).toHaveLength(1);
  });
});

describe('inspectCandles — ordering', () => {
  it('re-sorts an out-of-order series and says so without blocking', () => {
    const result = inspectCandles([
      candle('2026-09-11T14:32:00Z'),
      candle('2026-09-11T14:30:00Z'),
      candle('2026-09-11T14:31:00Z'),
    ]);
    expect(issues(result.findings)).toEqual([DataQualityIssue.TIMESTAMP_GAP]);
    expect(result.findings[0].blocking).toBe(false);
    expect(result.usable.map((c) => c.openTime.toISOString())).toEqual([
      '2026-09-11T14:30:00.000Z',
      '2026-09-11T14:31:00.000Z',
      '2026-09-11T14:32:00.000Z',
    ]);
  });
});

describe('inspectCandles — gaps', () => {
  it('flags a same-day intraday hole', () => {
    const result = inspectCandles([candle('2026-09-11T14:30:00Z'), candle('2026-09-11T14:34:00Z')]);
    expect(issues(result.findings)).toEqual([DataQualityIssue.MISSING_CANDLE]);
    expect(result.findings[0].detail).toContain('3 1m bar(s) missing');
    expect(result.findings[0].blocking).toBe(true);
  });

  it('does not flag an overnight break when no calendar is available', () => {
    // Without session data this is indistinguishable from a dropped bar, so it
    // is deliberately under-reported rather than raised as a false alarm.
    const result = inspectCandles([candle('2026-09-11T19:59:00Z'), candle('2026-09-14T13:30:00Z')]);
    expect(result.findings).toEqual([]);
  });

  it('does not flag daily-bar gaps without a calendar', () => {
    const result = inspectCandles([
      candle('2026-09-11T00:00:00Z', { timeframe: '1d' }),
      candle('2026-09-21T00:00:00Z', { timeframe: '1d' }),
    ]);
    expect(result.findings).toEqual([]);
  });

  it('uses a supplied session resolver to judge every gap', () => {
    const result = inspectCandles(
      [candle('2026-09-11T19:59:00Z'), candle('2026-09-14T13:30:00Z')],
      { isSessionGap: () => false },
    );
    // Told the market never closed, the same break is now a real hole.
    expect(issues(result.findings)).toEqual([DataQualityIssue.MISSING_CANDLE]);
  });

  it('suppresses a gap the session resolver accounts for', () => {
    const result = inspectCandles(
      [candle('2026-09-11T14:30:00Z'), candle('2026-09-11T14:40:00Z')],
      { isSessionGap: () => true },
    );
    expect(result.findings).toEqual([]);
  });

  it('respects the timeframe when counting missing bars', () => {
    const result = inspectCandles([
      candle('2026-09-11T14:30:00Z', { timeframe: '5m' }),
      candle('2026-09-11T15:00:00Z', { timeframe: '5m' }),
    ]);
    expect(result.findings[0].detail).toContain('5 5m bar(s) missing');
  });
});

describe('providerOutageFinding', () => {
  it('is feed-wide and always blocking', () => {
    const finding = providerOutageFinding('massive', 'connection refused');
    expect(finding.issue).toBe(DataQualityIssue.PROVIDER_OUTAGE);
    expect(finding.symbol).toBeNull();
    expect(finding.blocking).toBe(true);
    expect(finding.detail).toContain('connection refused');
  });
});
