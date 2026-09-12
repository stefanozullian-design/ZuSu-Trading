import type { PrismaClient } from '@prisma/client';
import { dec } from '@zusu/shared';
import type { Timeframe } from '../market-data/types.js';
import type { PaperBar, PaperPriceSource } from './paper-broker.js';

/**
 * The paper venue's price source: the bars already stored in the database.
 *
 * The same rows the charts, the scanner and the backtest read. That is the
 * point of the paper environment — the prices are the market's, and only the
 * execution is imagined, so a paper result can be compared with a live one.
 */
export class StoredBarPrices implements PaperPriceSource {
  constructor(
    private readonly db: PrismaClient,
    private readonly timeframe: Timeframe = '5m',
  ) {}

  async barsSince(symbol: string, since: Date): Promise<PaperBar[]> {
    const rows = await this.db.marketDataCandle.findMany({
      where: { symbol, timeframe: this.timeframe, openTime: { gt: since } },
      orderBy: { openTime: 'asc' },
      // A bound rather than everything: an order left resting for a month
      // should not pull a month of bars into memory on every poll.
      take: 500,
    });
    return rows.map(toBar);
  }

  async latestBar(symbol: string): Promise<PaperBar | null> {
    const row = await this.db.marketDataCandle.findFirst({
      where: { symbol, timeframe: this.timeframe },
      orderBy: { openTime: 'desc' },
    });
    return row ? toBar(row) : null;
  }
}

function toBar(row: {
  openTime: Date;
  open: { toString(): string };
  high: { toString(): string };
  low: { toString(): string };
  close: { toString(): string };
  volume: { toString(): string };
}): PaperBar {
  return {
    openTime: row.openTime,
    open: dec(row.open.toString()),
    high: dec(row.high.toString()),
    low: dec(row.low.toString()),
    close: dec(row.close.toString()),
    volume: dec(row.volume.toString()),
  };
}
