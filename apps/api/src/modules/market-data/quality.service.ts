import type { PrismaClient } from '@prisma/client';
import { MarketSession, type Decimal } from '@zusu/shared';
import {
  DataQualityIssue,
  inspectCandles,
  inspectQuote,
  providerOutageFinding,
  type QualityFinding,
  type QualityThresholds,
} from './quality.js';
import type { ProviderCandle, ProviderQuote } from './types.js';

/**
 * Ingestion and the market-data quality verdict (§6).
 *
 * This service is the only way market data reaches the database. Nothing is
 * stored before it has been inspected, so `market_data_quotes` and
 * `market_data_candles` cannot contain a bar the platform knows to be wrong.
 *
 * Findings are recorded as `market_data_quality_events`. A blocking event stays
 * open until data for the same symbol and issue passes, at which point it is
 * resolved — so the verdict reflects the feed's current state rather than
 * everything that has ever gone wrong with it.
 */

export interface IngestResult {
  /** Findings recorded for this batch. */
  findings: QualityFinding[];
  /** Rows written. Zero when everything was rejected. */
  stored: number;
  /** True when nothing blocking was found. */
  accepted: boolean;
}

export interface QualityVerdict {
  ok: boolean;
  /** Open blocking events that are not tied to one symbol — a feed-wide fault. */
  feedWide: OpenQualityEvent[];
  /** Open blocking events scoped to a single symbol. */
  bySymbol: OpenQualityEvent[];
}

export interface OpenQualityEvent {
  id: string;
  symbol: string | null;
  issue: DataQualityIssue;
  detail: string;
  detectedAt: Date;
}

export class MarketDataQualityService {
  /**
   * Last accepted price per symbol, for jump detection. Held in memory on
   * purpose: it is a within-session reference, and reading it back from the
   * database would reintroduce the price we may be about to reject.
   */
  private readonly referencePrices = new Map<string, Decimal>();

  constructor(
    private readonly db: PrismaClient,
    private readonly thresholds: Partial<QualityThresholds> = {},
  ) {}

  /**
   * Inspects a quote and stores it only if it passes.
   *
   * `marketSession` comes from the caller rather than the quote: the provider's
   * own view is recorded for cross-checking but is not authoritative, and the
   * market-calendar engine is not built yet. Until it is, callers pass the
   * session they can justify, and `CLOSED` is the honest default.
   */
  async ingestQuote(
    quote: ProviderQuote,
    options: { marketSession?: MarketSession } = {},
  ): Promise<IngestResult> {
    const instrument = await this.resolveInstrument(quote.symbol);
    const reference = this.referencePrices.get(quote.symbol) ?? null;

    const { usablePrice, findings } = inspectQuote(quote, {
      referencePrice: reference,
      thresholds: this.thresholds,
    });

    await this.recordFindings(quote.provider, findings, instrument?.id ?? null);

    if (usablePrice === null) {
      // A rejected quote is not stored. Storing it with `isStale` set would put
      // a price the platform has judged unusable where something could read it.
      return { findings, stored: 0, accepted: false };
    }

    if (!instrument) {
      // Nothing to attach the row to. An unknown symbol is a caller mistake, so
      // say so rather than silently dropping the data — and before touching the
      // reference price or resolving anything, so a failed call changes nothing.
      throw new Error(`No instrument record exists for ${quote.symbol}`);
    }

    await this.resolveOpenEvents(quote.symbol, findings);
    this.referencePrices.set(quote.symbol, usablePrice);

    await this.db.marketDataQuote.create({
      data: {
        instrumentId: instrument.id,
        symbol: quote.symbol,
        provider: quote.provider,
        price: usablePrice.toString(),
        bid: quote.bid?.toString() ?? null,
        ask: quote.ask?.toString() ?? null,
        bidSize: quote.bidSize?.toString() ?? null,
        askSize: quote.askSize?.toString() ?? null,
        volume: quote.volume?.toString() ?? null,
        sourceTimestamp: quote.sourceTimestamp,
        receivedTimestamp: quote.receivedTimestamp,
        marketSession: options.marketSession ?? MarketSession.CLOSED,
        isStale: false,
      },
    });

    return { findings, stored: 1, accepted: true };
  }

  /**
   * Inspects a candle series and stores the coherent bars.
   *
   * Unlike a quote, a series is partially salvageable: one impossible bar does
   * not invalidate the rest. The bad bars are recorded and dropped, the good
   * ones stored, and the batch reported as not accepted so the caller knows it
   * did not get what it asked for.
   */
  async ingestCandles(
    candles: ProviderCandle[],
    options: { provider: string; isSessionGap?: (from: Date, to: Date) => boolean } = {
      provider: 'unknown',
    },
  ): Promise<IngestResult> {
    const first = candles[0];
    if (!first) {
      return { findings: [], stored: 0, accepted: true };
    }

    const symbol = first.symbol;
    const instrument = await this.resolveInstrument(symbol);
    const { usable, findings } = inspectCandles(candles, {
      isSessionGap: options.isSessionGap,
    });

    await this.recordFindings(options.provider, findings, instrument?.id ?? null);

    if (!instrument) {
      // Same contract as `ingestQuote`: fail loudly before storing anything.
      throw new Error(`No instrument record exists for ${symbol}`);
    }

    let stored = 0;
    for (const candle of usable) {
      // Upsert on the natural key: re-fetching a range must not duplicate it,
      // and a provider revising a bar should update rather than conflict.
      await this.db.marketDataCandle.upsert({
        where: {
          instrumentId_timeframe_openTime: {
            instrumentId: instrument.id,
            timeframe: candle.timeframe,
            openTime: candle.openTime,
          },
        },
        create: {
          instrumentId: instrument.id,
          symbol: candle.symbol,
          timeframe: candle.timeframe,
          openTime: candle.openTime,
          closeTime: candle.closeTime,
          open: candle.open.toString(),
          high: candle.high.toString(),
          low: candle.low.toString(),
          close: candle.close.toString(),
          volume: candle.volume.toString(),
          vwap: candle.vwap?.toString() ?? null,
          tradeCount: candle.tradeCount,
          provider: options.provider,
          isAdjusted: candle.isAdjusted,
        },
        update: {
          closeTime: candle.closeTime,
          open: candle.open.toString(),
          high: candle.high.toString(),
          low: candle.low.toString(),
          close: candle.close.toString(),
          volume: candle.volume.toString(),
          vwap: candle.vwap?.toString() ?? null,
          tradeCount: candle.tradeCount,
          provider: options.provider,
          isAdjusted: candle.isAdjusted,
        },
      });
      stored += 1;
    }

    const accepted = !findings.some((f) => f.blocking);
    if (accepted) {
      await this.resolveOpenEvents(symbol, findings);
    }
    return { findings, stored, accepted };
  }

  /** Records a provider being unreachable. Feed-wide and always blocking. */
  async recordOutage(provider: string, detail: string): Promise<void> {
    await this.recordFindings(provider, [providerOutageFinding(provider, detail)], null);
  }

  /** Clears a recorded outage once the provider answers again. */
  async resolveOutage(provider: string): Promise<void> {
    await this.db.marketDataQualityEvent.updateMany({
      where: {
        provider,
        issue: DataQualityIssue.PROVIDER_OUTAGE,
        blocking: true,
        resolvedAt: null,
      },
      data: { resolvedAt: new Date(), blocking: false },
    });
  }

  /**
   * The current verdict, from open blocking events.
   *
   * Feed-wide faults and per-symbol faults are returned separately because they
   * mean different things to the trading gate: a dead provider blocks
   * everything, while one impossible symbol should not halt a whole portfolio.
   */
  async verdict(): Promise<QualityVerdict> {
    const open = await this.db.marketDataQualityEvent.findMany({
      where: { blocking: true, resolvedAt: null },
      orderBy: { detectedAt: 'desc' },
      take: 100,
    });

    const events: OpenQualityEvent[] = open.map((row) => ({
      id: row.id,
      symbol: row.symbol,
      issue: row.issue as DataQualityIssue,
      detail: row.detail,
      detectedAt: row.detectedAt,
    }));

    const feedWide = events.filter((e) => e.symbol === null);
    const bySymbol = events.filter((e) => e.symbol !== null);
    return { ok: events.length === 0, feedWide, bySymbol };
  }

  /** Open blocking events for one symbol. */
  async verdictForSymbol(symbol: string): Promise<OpenQualityEvent[]> {
    const open = await this.db.marketDataQualityEvent.findMany({
      where: { symbol, blocking: true, resolvedAt: null },
      orderBy: { detectedAt: 'desc' },
      take: 20,
    });
    return open.map((row) => ({
      id: row.id,
      symbol: row.symbol,
      issue: row.issue as DataQualityIssue,
      detail: row.detail,
      detectedAt: row.detectedAt,
    }));
  }

  /**
   * Clears the in-memory jump reference. Called when a session ends: comparing
   * today's open against yesterday's close would report every overnight move as
   * an abnormal jump.
   */
  clearReferencePrices(): void {
    this.referencePrices.clear();
  }

  private async recordFindings(
    provider: string,
    findings: QualityFinding[],
    instrumentId: string | null,
  ): Promise<void> {
    if (findings.length === 0) return;
    await this.db.marketDataQualityEvent.createMany({
      data: findings.map((finding) => ({
        instrumentId,
        symbol: finding.symbol,
        provider,
        issue: finding.issue,
        detail: finding.detail,
        blocking: finding.blocking,
      })),
    });
  }

  /**
   * Resolves open events for issues that did not recur.
   *
   * Only issues absent from the latest findings are cleared: data that is still
   * stale must not be marked healthy just because it was inspected again.
   */
  private async resolveOpenEvents(symbol: string, findings: QualityFinding[]): Promise<void> {
    const stillFailing = new Set(findings.filter((f) => f.blocking).map((f) => f.issue));
    const clearable = Object.values(DataQualityIssue).filter(
      (issue) => issue !== DataQualityIssue.PROVIDER_OUTAGE && !stillFailing.has(issue),
    );
    if (clearable.length === 0) return;

    await this.db.marketDataQualityEvent.updateMany({
      where: {
        symbol,
        issue: { in: clearable },
        blocking: true,
        resolvedAt: null,
      },
      data: { resolvedAt: new Date(), blocking: false },
    });
  }

  private async resolveInstrument(symbol: string) {
    return this.db.instrument.findUnique({ where: { symbol }, select: { id: true } });
  }
}
