import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { Permission, type Decimal } from '@zusu/shared';
import type { AppContainer } from '../../container.js';
import { principalOf } from '../../plugins/auth.js';
import { TIMEFRAMES, type Timeframe } from './types.js';

/**
 * Read-only market-data routes (§6-8).
 *
 * Everything here is a query. There is no route that places an order, and
 * nothing in this module can create one — market data informs a decision, it
 * never authorises one.
 *
 * Decimals cross the wire as strings. A JSON number would silently round a
 * price on the way out, which is the one thing the whole decimal discipline in
 * this codebase exists to prevent.
 */

const decimalOut = z.string().nullable();
const timeframeParam = z.enum(TIMEFRAMES);

const symbolParams = z.object({ symbol: z.string().min(1).max(20) });

const candleQuery = z.object({
  timeframe: timeframeParam.default('5m'),
  limit: z.coerce.number().int().min(1).max(2000).default(200),
});

const str = (value: Decimal | null | undefined): string | null =>
  value === null || value === undefined ? null : value.toString();

const instrumentDto = z.object({
  symbol: z.string(),
  name: z.string().nullable(),
  assetClass: z.string(),
  exchange: z.string().nullable(),
  sector: z.string().nullable(),
  isTradable: z.boolean(),
  candleCount: z.number().int(),
  /** Whether a paper portfolio can price it: five-minute bars exist. */
  markable: z.boolean(),
});

export async function registerMarketDataRoutes(
  app: FastifyInstance,
  container: AppContainer,
): Promise<void> {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const read = { preHandler: app.requirePermission(Permission.MARKET_DATA_READ) };

  typed.get(
    '/instruments/search',
    {
      ...read,
      schema: {
        tags: ['market-data'],
        summary: 'Ask the data provider what it knows by this name',
        description:
          'The provider is the authority on whether a symbol exists. This platform never ' +
          'records an instrument it cannot price: one would chart as a gap, mark as a dash, ' +
          'and fail every risk check with a message about missing data rather than about a ' +
          'symbol that was never real.',
        querystring: z.object({ q: z.string().trim().min(1).max(40) }),
        response: { 200: z.object({ results: z.array(instrumentDto) }) },
      },
    },
    async (request, reply) =>
      reply.send({
        results: await container.instruments.search(principalOf(request), request.query.q),
      }),
  );

  typed.post(
    '/instruments',
    {
      preHandler: app.requirePermission(Permission.WATCHLIST_WRITE),
      schema: {
        tags: ['market-data'],
        summary: 'Add a symbol the provider confirms exists, and backfill its history',
        body: z.object({
          symbol: z.string().trim().min(1).max(12),
          days: z.number().int().min(1).max(3650).optional(),
        }),
        response: { 201: instrumentDto },
      },
    },
    async (request, reply) => {
      const instrument = await container.instruments.add(
        principalOf(request),
        request.body.symbol,
        request.body.days === undefined ? {} : { days: request.body.days },
      );
      return reply.status(201).send(instrument);
    },
  );

  typed.get(
    '/instruments',
    {
      ...read,
      schema: {
        tags: ['market-data'],
        summary: 'Instruments with stored market data',
        response: {
          200: z.object({
            provider: z.string(),
            isDelayed: z.boolean().nullable(),
            instruments: z.array(
              z.object({
                symbol: z.string(),
                name: z.string().nullable(),
                assetClass: z.string(),
                exchange: z.string().nullable(),
                isTradable: z.boolean(),
                barCount: z.number().int(),
                lastClose: decimalOut,
                lastBarAt: z.string().datetime().nullable(),
              }),
            ),
          }),
        },
      },
    },
    async (_request, reply) => {
      const provider = container.marketData.tryResolve();
      const instruments = await container.db.instrument.findMany({
        orderBy: { symbol: 'asc' },
      });

      const rows = [];
      for (const instrument of instruments) {
        const [barCount, latest] = await Promise.all([
          container.db.marketDataCandle.count({ where: { symbol: instrument.symbol } }),
          container.db.marketDataCandle.findFirst({
            where: { symbol: instrument.symbol },
            orderBy: { openTime: 'desc' },
            select: { close: true, openTime: true },
          }),
        ]);
        rows.push({
          symbol: instrument.symbol,
          name: instrument.name,
          assetClass: instrument.assetClass,
          exchange: instrument.exchange,
          isTradable: instrument.isTradable,
          barCount,
          lastClose: latest ? latest.close.toString() : null,
          lastBarAt: latest ? latest.openTime.toISOString() : null,
        });
      }

      return reply.send({
        // Named honestly: with no provider configured this is the simulator,
        // and the UI says so rather than implying a live feed.
        provider: provider?.name ?? 'demo-simulator',
        isDelayed: provider ? provider.isDelayed : null,
        instruments: rows,
      });
    },
  );

  typed.get(
    '/:symbol/candles',
    {
      ...read,
      schema: {
        tags: ['market-data'],
        summary: 'Stored candles for a symbol, oldest first',
        params: symbolParams,
        querystring: candleQuery,
        response: {
          200: z.object({
            symbol: z.string(),
            timeframe: z.string(),
            candles: z.array(
              z.object({
                openTime: z.string().datetime(),
                open: z.string(),
                high: z.string(),
                low: z.string(),
                close: z.string(),
                volume: z.string(),
                vwap: decimalOut,
                provider: z.string(),
              }),
            ),
          }),
        },
      },
    },
    async (request, reply) => {
      const symbol = request.params.symbol.toUpperCase();
      const { timeframe, limit } = request.query;

      const rows = await container.db.marketDataCandle.findMany({
        where: { symbol, timeframe },
        orderBy: { openTime: 'desc' },
        take: limit,
      });

      return reply.send({
        symbol,
        timeframe,
        candles: rows.reverse().map((row) => ({
          openTime: row.openTime.toISOString(),
          open: row.open.toString(),
          high: row.high.toString(),
          low: row.low.toString(),
          close: row.close.toString(),
          volume: row.volume.toString(),
          vwap: row.vwap === null ? null : row.vwap.toString(),
          provider: row.provider,
        })),
      });
    },
  );

  typed.get(
    '/:symbol/indicators',
    {
      ...read,
      schema: {
        tags: ['market-data'],
        summary: 'Every indicator as of the newest stored bar',
        description:
          'A null value means the stored history is too short to define that ' +
          'indicator, never zero. `barsAvailable` says how short.',
        params: symbolParams,
        querystring: candleQuery,
        response: {
          200: z
            .object({
              symbol: z.string(),
              timeframe: z.string(),
              asOf: z.string().datetime(),
              close: z.string(),
              barsAvailable: z.number().int(),
              sma20: decimalOut,
              sma50: decimalOut,
              ema12: decimalOut,
              ema26: decimalOut,
              rsi14: decimalOut,
              macd: decimalOut,
              macdSignal: decimalOut,
              macdHistogram: decimalOut,
              bollingerUpper: decimalOut,
              bollingerMiddle: decimalOut,
              bollingerLower: decimalOut,
              atr14: decimalOut,
              vwap: decimalOut,
              stochasticK: decimalOut,
              stochasticD: decimalOut,
              obv: z.string(),
            })
            .nullable(),
        },
      },
    },
    async (request, reply) => {
      const symbol = request.params.symbol.toUpperCase();
      const { timeframe, limit } = request.query;
      const snapshot = await container.indicators.snapshot(symbol, timeframe as Timeframe, {
        limit,
      });
      if (!snapshot) return reply.send(null);

      return reply.send({
        symbol: snapshot.symbol,
        timeframe: snapshot.timeframe,
        asOf: snapshot.asOf.toISOString(),
        close: snapshot.close.toString(),
        barsAvailable: snapshot.barsAvailable,
        sma20: str(snapshot.sma20),
        sma50: str(snapshot.sma50),
        ema12: str(snapshot.ema12),
        ema26: str(snapshot.ema26),
        rsi14: str(snapshot.rsi14),
        macd: str(snapshot.macd),
        macdSignal: str(snapshot.macdSignal),
        macdHistogram: str(snapshot.macdHistogram),
        bollingerUpper: str(snapshot.bollingerUpper),
        bollingerMiddle: str(snapshot.bollingerMiddle),
        bollingerLower: str(snapshot.bollingerLower),
        atr14: str(snapshot.atr14),
        vwap: str(snapshot.vwap),
        stochasticK: str(snapshot.stochasticK),
        stochasticD: str(snapshot.stochasticD),
        obv: snapshot.obv.toString(),
      });
    },
  );

  typed.get(
    '/:symbol/indicator-series',
    {
      ...read,
      schema: {
        tags: ['market-data'],
        summary: 'Indicator values for every bar, aligned to the candle series',
        description:
          'Arrays are the same length as the candle array from /candles, so ' +
          'index i is the value as of bar i. Nulls are warm-up, never zero.',
        params: symbolParams,
        querystring: candleQuery,
        response: {
          200: z.object({
            symbol: z.string(),
            timeframe: z.string(),
            length: z.number().int(),
            sma20: z.array(decimalOut),
            sma50: z.array(decimalOut),
            bollingerUpper: z.array(decimalOut),
            bollingerLower: z.array(decimalOut),
            rsi14: z.array(decimalOut),
            macd: z.array(decimalOut),
            macdSignal: z.array(decimalOut),
            macdHistogram: z.array(decimalOut),
          }),
        },
      },
    },
    async (request, reply) => {
      const symbol = request.params.symbol.toUpperCase();
      const { timeframe, limit } = request.query;
      const series = await container.indicators.series(symbol, timeframe as Timeframe, { limit });

      return reply.send({
        symbol,
        timeframe,
        length: series.length,
        sma20: series.sma20.map(str),
        sma50: series.sma50.map(str),
        bollingerUpper: series.bollingerUpper.map(str),
        bollingerLower: series.bollingerLower.map(str),
        rsi14: series.rsi14.map(str),
        macd: series.macd.map(str),
        macdSignal: series.macdSignal.map(str),
        macdHistogram: series.macdHistogram.map(str),
      });
    },
  );

  typed.get(
    '/:symbol/tradable',
    {
      ...read,
      schema: {
        tags: ['market-data'],
        summary: 'Whether this symbol may be traded right now, and why not',
        params: symbolParams,
        response: {
          200: z.object({
            symbol: z.string(),
            tradable: z.boolean(),
            session: z.string(),
            marketCode: z.string(),
            reason: z.string().nullable(),
          }),
        },
      },
    },
    async (request, reply) => {
      const symbol = request.params.symbol.toUpperCase();
      const verdict = await container.calendar.isTradable(symbol);
      return reply.send({ symbol, ...verdict });
    },
  );

  typed.get(
    '/quality',
    {
      ...read,
      schema: {
        tags: ['market-data'],
        summary: 'Open data-quality events, and whether they block trading',
        description:
          'Feed-wide faults block every non-DEMO portfolio. Per-symbol faults ' +
          'block only orders naming that symbol.',
        response: {
          200: z.object({
            ok: z.boolean(),
            feedWide: z.array(qualityEvent()),
            bySymbol: z.array(qualityEvent()),
            recent: z.array(
              z.object({
                symbol: z.string().nullable(),
                issue: z.string(),
                detail: z.string(),
                blocking: z.boolean(),
                detectedAt: z.string().datetime(),
                resolvedAt: z.string().datetime().nullable(),
              }),
            ),
          }),
        },
      },
    },
    async (_request, reply) => {
      const verdict = await container.dataQuality.verdict();
      // Resolved events are shown too: "nothing is wrong now" is much more
      // credible next to a list of things that were wrong and got fixed.
      const recent = await container.db.marketDataQualityEvent.findMany({
        orderBy: { detectedAt: 'desc' },
        take: 25,
      });

      return reply.send({
        ok: verdict.ok,
        feedWide: verdict.feedWide.map(serialiseEvent),
        bySymbol: verdict.bySymbol.map(serialiseEvent),
        recent: recent.map((row) => ({
          symbol: row.symbol,
          issue: row.issue,
          detail: row.detail,
          blocking: row.blocking,
          detectedAt: row.detectedAt.toISOString(),
          resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
        })),
      });
    },
  );

  typed.get(
    '/calendar/:marketCode',
    {
      ...read,
      schema: {
        tags: ['market-data'],
        summary: 'Session state for a market, and the days around today',
        params: z.object({ marketCode: z.string().min(1).max(12) }),
        response: {
          200: z.object({
            marketCode: z.string(),
            session: z.string(),
            asOf: z.string().datetime(),
            days: z.array(
              z.object({
                date: z.string(),
                isTradingDay: z.boolean(),
                regularOpen: z.string().datetime().nullable(),
                regularClose: z.string().datetime().nullable(),
                isEarlyClose: z.boolean(),
                holidayName: z.string().nullable(),
              }),
            ),
            openHalts: z.array(
              z.object({
                symbol: z.string(),
                reason: z.string(),
                haltedAt: z.string().datetime(),
              }),
            ),
          }),
        },
      },
    },
    async (request, reply) => {
      const marketCode = request.params.marketCode.toUpperCase();
      const now = new Date();
      const session = await container.calendar.sessionFor(marketCode, now);

      const from = new Date(now.getTime() - 3 * 86_400_000);
      const to = new Date(now.getTime() + 7 * 86_400_000);
      const days = await container.db.marketCalendarDay.findMany({
        where: { marketCode, date: { gte: midnight(from), lte: midnight(to) } },
        orderBy: { date: 'asc' },
      });
      const openHalts = await container.calendar.openHalts();

      return reply.send({
        marketCode,
        session,
        asOf: now.toISOString(),
        days: days.map((day) => ({
          date: day.date.toISOString().slice(0, 10),
          isTradingDay: day.isTradingDay,
          regularOpen: day.regularOpen ? day.regularOpen.toISOString() : null,
          regularClose: day.regularClose ? day.regularClose.toISOString() : null,
          isEarlyClose: day.isEarlyClose,
          holidayName: day.holidayName,
        })),
        openHalts: openHalts.map((halt) => ({
          symbol: halt.symbol,
          reason: halt.reason,
          haltedAt: halt.haltedAt.toISOString(),
        })),
      });
    },
  );
}

function qualityEvent() {
  return z.object({
    symbol: z.string().nullable(),
    issue: z.string(),
    detail: z.string(),
    detectedAt: z.string().datetime(),
  });
}

function serialiseEvent(event: {
  symbol: string | null;
  issue: string;
  detail: string;
  detectedAt: Date;
}) {
  return {
    symbol: event.symbol,
    issue: event.issue,
    detail: event.detail,
    detectedAt: event.detectedAt.toISOString(),
  };
}

function midnight(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 0, 0, 0),
  );
}
