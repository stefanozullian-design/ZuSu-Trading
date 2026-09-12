import { describe, expect, it, vi } from 'vitest';
import { MassiveProvider } from './massive-provider.js';
import { MarketDataError } from './types.js';

const BASE = 'https://polygon.test';

/**
 * A fake transport recording every request. Deliberately not `msw`: the point
 * of most of these tests is the exact URL and headers the adapter produces.
 */
function stubFetch(
  handler: (url: string) => { status?: number; body?: unknown; headers?: Record<string, string> },
) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const impl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const { status = 200, body = {}, headers = {} } = handler(url);
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    });
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

function provider(fetchImpl: typeof fetch, isDelayed = true) {
  return new MassiveProvider({ apiKey: 'test-key', baseUrl: BASE, fetchImpl, isDelayed });
}

describe('MassiveProvider — construction', () => {
  it('refuses to construct without an API key', () => {
    expect(() => new MassiveProvider({ apiKey: '' })).toThrow(/requires an API key/);
  });

  it('sends the key as a bearer header, never in the query string', async () => {
    const { impl, calls } = stubFetch(() => ({ body: { market: 'open' } }));
    await provider(impl).healthCheck();

    expect(calls[0].url).not.toContain('test-key');
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer test-key');
  });
});

describe('MassiveProvider.getQuote', () => {
  const snapshot = {
    ticker: {
      ticker: 'AAPL',
      day: { v: 41_000_000 },
      lastTrade: { p: 189.42, t: 1_726_150_000_000_000_000 },
      lastQuote: { p: 189.4, P: 189.45, s: 300, S: 500, t: 1_726_150_000_000_000_000 },
      updated: 1_726_150_000_000_000_000,
    },
  };

  it('maps a snapshot into a quote with both clocks', async () => {
    const { impl } = stubFetch(() => ({ body: snapshot }));
    const before = Date.now();
    const quote = await provider(impl).getQuote('aapl');

    expect(quote.symbol).toBe('AAPL');
    expect(quote.provider).toBe('massive');
    expect(quote.price?.toString()).toBe('189.42');
    expect(quote.bid?.toString()).toBe('189.4');
    expect(quote.ask?.toString()).toBe('189.45');
    expect(quote.bidSize?.toString()).toBe('300');
    expect(quote.askSize?.toString()).toBe('500');
    expect(quote.volume?.toString()).toBe('41000000');

    // Nanoseconds converted to a millisecond Date.
    expect(quote.sourceTimestamp.getTime()).toBe(1_726_150_000_000);
    expect(quote.receivedTimestamp.getTime()).toBeGreaterThanOrEqual(before);
    // The provider never claims to know the session; the calendar engine does.
    expect(quote.marketSession).toBeNull();
  });

  it('uppercases and trims the symbol before requesting it', async () => {
    const { impl, calls } = stubFetch(() => ({ body: snapshot }));
    await provider(impl).getQuote('  msft ');
    expect(calls[0].url).toBe(`${BASE}/v2/snapshot/locale/us/markets/stocks/tickers/MSFT`);
  });

  it('rejects an empty symbol', async () => {
    const { impl } = stubFetch(() => ({ body: snapshot }));
    await expect(provider(impl).getQuote('   ')).rejects.toThrow(/Symbol is required/);
  });

  it('reports a missing bid as null rather than zero', async () => {
    const { impl } = stubFetch(() => ({
      body: {
        ticker: {
          ticker: 'THIN',
          lastTrade: { p: 12.5, t: 1_726_150_000_000_000_000 },
          lastQuote: { P: 12.6, S: 100, t: 1_726_150_000_000_000_000 },
        },
      },
    }));
    const quote = await provider(impl).getQuote('THIN');

    // A zero bid would read downstream as a real, catastrophic price.
    expect(quote.bid).toBeNull();
    expect(quote.bidSize).toBeNull();
    expect(quote.ask?.toString()).toBe('12.6');
  });

  it('falls back from the trade clock to the quote clock', async () => {
    const { impl } = stubFetch(() => ({
      body: { ticker: { ticker: 'X', lastQuote: { p: 1, P: 2, t: 1_700_000_000_000_000_000 } } },
    }));
    const quote = await provider(impl).getQuote('X');
    expect(quote.sourceTimestamp.getTime()).toBe(1_700_000_000_000);
    expect(quote.price).toBeNull();
  });

  it('refuses a snapshot with no timestamp at all', async () => {
    const { impl } = stubFetch(() => ({ body: { ticker: { ticker: 'X', lastTrade: { p: 1 } } } }));
    // Substituting our own clock here would make a frozen feed look fresh.
    await expect(provider(impl).getQuote('X')).rejects.toThrow(/carries no timestamp/);
  });

  it('throws when the snapshot envelope is empty', async () => {
    const { impl } = stubFetch(() => ({ body: {} }));
    await expect(provider(impl).getQuote('NOPE')).rejects.toThrow(/no snapshot/);
  });
});

describe('MassiveProvider.getQuotes', () => {
  it('de-duplicates symbols and requests them one at a time', async () => {
    const { impl, calls } = stubFetch(() => ({
      body: { ticker: { ticker: 'A', lastTrade: { p: 1, t: 1_700_000_000_000_000_000 } } },
    }));
    const quotes = await provider(impl).getQuotes(['AAPL', 'aapl', 'MSFT']);

    expect(quotes).toHaveLength(2);
    expect(calls).toHaveLength(2);
  });

  it('returns an empty array without calling out', async () => {
    const { impl, calls } = stubFetch(() => ({ body: {} }));
    expect(await provider(impl).getQuotes([])).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe('MassiveProvider.getCandles', () => {
  const from = new Date('2026-09-01T00:00:00Z');
  const to = new Date('2026-09-02T00:00:00Z');

  it('maps aggregates and derives each close time from the timeframe', async () => {
    const { impl, calls } = stubFetch(() => ({
      body: {
        results: [
          { t: 1_756_704_600_000, o: 100, h: 101, l: 99.5, c: 100.75, v: 12_000, vw: 100.2, n: 84 },
        ],
      },
    }));
    const candles = await provider(impl).getCandles({ symbol: 'SPY', timeframe: '5m', from, to });

    expect(calls[0].url).toContain('/v2/aggs/ticker/SPY/range/5/minute/2026-09-01/2026-09-02');
    expect(calls[0].url).toContain('adjusted=true');
    expect(calls[0].url).toContain('sort=asc');

    expect(candles).toHaveLength(1);
    const [candle] = candles;
    expect(candle.open.toString()).toBe('100');
    expect(candle.close.toString()).toBe('100.75');
    expect(candle.vwap?.toString()).toBe('100.2');
    expect(candle.tradeCount).toBe(84);
    expect(candle.isAdjusted).toBe(true);
    expect(candle.closeTime.getTime() - candle.openTime.getTime()).toBe(5 * 60_000);
  });

  it('records isAdjusted=false when unadjusted data was asked for', async () => {
    const { impl, calls } = stubFetch(() => ({
      body: { results: [{ t: 1_756_704_600_000, o: 1, h: 1, l: 1, c: 1, v: 1 }] },
    }));
    const candles = await provider(impl).getCandles({
      symbol: 'SPY',
      timeframe: '1d',
      from,
      to,
      adjusted: false,
    });
    expect(calls[0].url).toContain('adjusted=false');
    expect(candles[0].isAdjusted).toBe(false);
  });

  it('drops a partial bar instead of zero-filling it', async () => {
    const { impl } = stubFetch(() => ({
      body: {
        results: [
          { t: 1, o: 1, h: 2, l: 0.5, c: 1.5, v: 10 },
          { t: 2, o: 1, h: 2, l: 0.5, v: 10 }, // no close
        ],
      },
    }));
    const candles = await provider(impl).getCandles({ symbol: 'X', timeframe: '1m', from, to });
    // The resulting hole is the quality layer's MISSING_CANDLE to report.
    expect(candles).toHaveLength(1);
  });

  it('follows next_url until the pages run out', async () => {
    let page = 0;
    const { impl, calls } = stubFetch(() => {
      page += 1;
      return {
        body: {
          results: [{ t: page, o: 1, h: 1, l: 1, c: 1, v: 1 }],
          next_url: page < 3 ? `${BASE}/v2/aggs/next/${page}` : undefined,
        },
      };
    });
    const candles = await provider(impl).getCandles({ symbol: 'X', timeframe: '1d', from, to });

    expect(calls).toHaveLength(3);
    expect(candles).toHaveLength(3);
  });

  it('rejects an inverted date range', async () => {
    const { impl } = stubFetch(() => ({ body: {} }));
    await expect(
      provider(impl).getCandles({ symbol: 'X', timeframe: '1d', from: to, to: from }),
    ).rejects.toThrow(/is after/);
  });
});

describe('MassiveProvider.getCorporateActions', () => {
  it('converts a 7-for-1 split into a ratio of 7 and sorts by date', async () => {
    const { impl } = stubFetch((url) =>
      url.includes('/splits')
        ? { body: { results: [{ execution_date: '2026-06-09', split_from: 1, split_to: 7 }] } }
        : { body: { results: [{ ex_dividend_date: '2026-02-10', cash_amount: 0.24 }] } },
    );
    const actions = await provider(impl).getCorporateActions(
      'AAPL',
      new Date('2026-01-01T00:00:00Z'),
      new Date('2026-12-31T00:00:00Z'),
    );

    expect(actions.map((a) => a.type)).toEqual(['DIVIDEND', 'SPLIT']);
    const split = actions[1];
    // A backtest that read this as a price change would see an 86% crash.
    expect(split.splitRatio?.toString()).toBe('7');
    expect(split.cashAmount).toBeNull();
    expect(actions[0].cashAmount?.toString()).toBe('0.24');
    expect(actions[0].splitRatio).toBeNull();
  });

  it('skips records missing the fields that give them meaning', async () => {
    const { impl } = stubFetch((url) =>
      url.includes('/splits')
        ? { body: { results: [{ execution_date: '2026-06-09', split_to: 2 }] } }
        : { body: { results: [{ cash_amount: 0.5 }] } },
    );
    const actions = await provider(impl).getCorporateActions('X', new Date(0), new Date());
    expect(actions).toEqual([]);
  });
});

describe('MassiveProvider.searchInstruments', () => {
  it('classifies ETFs apart from ordinary equity', async () => {
    const { impl } = stubFetch(() => ({
      body: {
        results: [
          { ticker: 'SPY', name: 'SPDR S&P 500', type: 'ETF', primary_exchange: 'ARCX' },
          {
            ticker: 'AAPL',
            name: 'Apple Inc.',
            type: 'CS',
            primary_exchange: 'XNAS',
            sic_description: 'Electronic Computers',
            active: true,
          },
        ],
      },
    }));
    const found = await provider(impl).searchInstruments('app');

    expect(found[0]).toMatchObject({ symbol: 'SPY', assetClass: 'ETF', marketCode: 'ARCX' });
    expect(found[1]).toMatchObject({
      symbol: 'AAPL',
      assetClass: 'EQUITY',
      sector: 'Electronic Computers',
    });
  });

  it('ignores rows with no ticker', async () => {
    const { impl } = stubFetch(() => ({ body: { results: [{ name: 'nameless' }] } }));
    expect(await provider(impl).searchInstruments('x')).toEqual([]);
  });
});

describe('MassiveProvider.getCalendar', () => {
  const upcoming = [
    { date: '2026-11-26', exchange: 'NYSE', name: 'Thanksgiving', status: 'closed' },
    {
      date: '2026-11-27',
      exchange: 'NYSE',
      name: 'Thanksgiving',
      status: 'early-close',
      open: '2026-11-27T14:30:00.000Z',
      close: '2026-11-27T18:00:00.000Z',
    },
    { date: '2026-11-26', exchange: 'NASDAQ', name: 'Thanksgiving', status: 'closed' },
  ];

  it('marks a holiday closed and an early close with real boundaries', async () => {
    const { impl } = stubFetch(() => ({ body: upcoming }));
    const days = await provider(impl).getCalendar(
      'XNYS',
      new Date('2026-11-26T00:00:00Z'),
      new Date('2026-11-27T00:00:00Z'),
    );

    expect(days).toHaveLength(2);
    expect(days[0]).toMatchObject({ isTradingDay: false, holidayName: 'Thanksgiving' });
    expect(days[1].isTradingDay).toBe(true);
    expect(days[1].isEarlyClose).toBe(true);
    expect(days[1].regularClose?.toISOString()).toBe('2026-11-27T18:00:00.000Z');
  });

  it('leaves session boundaries null on an ordinary day rather than guessing 09:30', async () => {
    const { impl } = stubFetch(() => ({ body: [] }));
    const [day] = await provider(impl).getCalendar(
      'XNYS',
      new Date('2026-09-09T00:00:00Z'),
      new Date('2026-09-09T00:00:00Z'),
    );

    expect(day.isTradingDay).toBe(true);
    // §7: no hard-coded session times. "Open, times unknown" is the honest answer.
    expect(day.regularOpen).toBeNull();
    expect(day.regularClose).toBeNull();
  });

  it('treats weekends as non-trading days', async () => {
    const { impl } = stubFetch(() => ({ body: [] }));
    const days = await provider(impl).getCalendar(
      'XNYS',
      new Date('2026-09-12T00:00:00Z'), // Saturday
      new Date('2026-09-13T00:00:00Z'), // Sunday
    );
    expect(days.map((d) => d.isTradingDay)).toEqual([false, false]);
  });

  it('ignores holidays belonging to another exchange', async () => {
    const { impl } = stubFetch(() => ({
      body: [{ date: '2026-11-26', exchange: 'NASDAQ', name: 'Thanksgiving', status: 'closed' }],
    }));
    const [day] = await provider(impl).getCalendar(
      'XNYS',
      new Date('2026-11-26T00:00:00Z'),
      new Date('2026-11-26T00:00:00Z'),
    );
    expect(day.holidayName).toBeNull();
  });
});

describe('MassiveProvider — transport failures', () => {
  it('marks a rate limit retryable', async () => {
    const { impl } = stubFetch(() => ({ status: 429, body: {} }));
    await expect(provider(impl).getQuote('X')).rejects.toMatchObject({
      name: 'MarketDataError',
      retryable: true,
      status: 429,
    });
  });

  it('does not retry a rejected key', async () => {
    const { impl } = stubFetch(() => ({ status: 403, body: {} }));
    await expect(provider(impl).getQuote('X')).rejects.toMatchObject({
      retryable: false,
      status: 403,
    });
  });

  it('marks a 5xx retryable and a 404 not', async () => {
    const server = stubFetch(() => ({ status: 503, body: {} }));
    await expect(provider(server.impl).getQuote('X')).rejects.toMatchObject({ retryable: true });

    const missing = stubFetch(() => ({ status: 404, body: {} }));
    await expect(provider(missing.impl).getQuote('X')).rejects.toMatchObject({ retryable: false });
  });

  it('surfaces a malformed body as an error, not as empty data', async () => {
    const impl = vi.fn(
      async () =>
        new Response('<html>gateway</html>', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ) as unknown as typeof fetch;
    await expect(provider(impl).getQuote('X')).rejects.toThrow(/malformed JSON/);
  });

  it('never leaks the API key in an error message', async () => {
    const { impl } = stubFetch(() => ({ status: 403, body: {} }));
    await expect(provider(impl).getQuote('X')).rejects.toSatisfy(
      (err: MarketDataError) => !err.message.includes('test-key'),
    );
  });
});

describe('MassiveProvider.healthCheck', () => {
  it('reports ok with the remaining rate-limit allowance', async () => {
    const { impl } = stubFetch(() => ({
      body: { market: 'open' },
      headers: { 'x-ratelimit-remaining': '42' },
    }));
    const health = await provider(impl).healthCheck();

    expect(health.ok).toBe(true);
    expect(health.rateLimitRemaining).toBe(42);
    expect(health.detail).toBe('delayed feed');
  });

  it('reports an unknown allowance as null, not as plenty', async () => {
    const { impl } = stubFetch(() => ({ body: { market: 'open' } }));
    expect((await provider(impl).healthCheck()).rateLimitRemaining).toBeNull();
  });

  it('returns ok=false rather than throwing', async () => {
    const { impl } = stubFetch(() => ({ status: 500, body: {} }));
    const health = await provider(impl).healthCheck();

    expect(health.ok).toBe(false);
    expect(health.latencyMs).toBeNull();
  });

  it('distinguishes a real-time plan from a delayed one', async () => {
    const { impl } = stubFetch(() => ({ body: { market: 'open' } }));
    expect((await provider(impl, false).healthCheck()).detail).toBe('real-time feed');
  });
});
