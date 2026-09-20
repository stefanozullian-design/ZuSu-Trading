import type { Portfolio } from '@prisma/client';
import { type Decimal, TradingEnvironment } from '@zusu/shared';
import type { BrokerRegistry } from '../broker/broker-registry.js';

/**
 * Current prices for a set of symbols.
 *
 * Extracted so that every reader of "what is this worth" uses the same one.
 * Two implementations of this would eventually disagree, and the disagreement
 * would surface as a dashboard and a risk check quoting different values for
 * the same holding on the same screen.
 *
 * A symbol that cannot be priced is simply absent from the map. It is never
 * given its entry price as a stand-in: a position marked at what was paid for
 * it reads as exactly break-even, which is a claim rather than a measurement.
 */
export async function markPrices(
  brokers: BrokerRegistry,
  portfolio: Portfolio,
  symbols: string[],
): Promise<Map<string, Decimal>> {
  const marks = new Map<string, Decimal>();
  if (symbols.length === 0) return marks;
  if (!brokers.isSupported(portfolio.environment as TradingEnvironment)) return marks;

  const broker = brokers.forPortfolio(portfolio);
  for (const symbol of new Set(symbols)) {
    try {
      marks.set(symbol, (await broker.getQuote(symbol)).price);
    } catch {
      // Left unmarked. Never invented.
    }
  }
  return marks;
}
