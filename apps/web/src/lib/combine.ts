import type { PortfolioSummary } from '@/lib/types';

/**
 * Adding several portfolios up.
 *
 * The arithmetic is trivial and the honesty is not. Three rules, each of which
 * the obvious implementation gets wrong:
 *
 * 1. **A total containing an unknown is unknown.** If one portfolio's equity
 *    could not be computed because its positions are unmarked, the sum of the
 *    others is not "the total" — it is a smaller number wearing the total's
 *    label, and it is wrong in the reassuring direction. Null propagates.
 *
 * 2. **Some things do not add up at all.** "Daily risk used" is a percentage
 *    of *that portfolio's* daily loss limit. Two portfolios at 50% are not one
 *    portfolio at 100%, or at 50%, or at any number — the quantity does not
 *    exist across books. It is reported per portfolio or not at all.
 *
 * 3. **Mixed currencies cannot be summed** without a rate, and this platform
 *    has no rates. A combination spanning currencies reports what it cannot
 *    add rather than adding it anyway.
 */

export interface Combined {
  /** Null when the portfolios do not share one currency. */
  baseCurrency: string | null;
  cashBalance: string | null;
  positionsValue: string | null;
  equity: string | null;
  initialCapital: string | null;
  dailyPnl: string | null;
  openPositions: number;
  count: number;
  /** Why a figure is missing, when one is. Shown rather than left blank. */
  caveats: string[];
}

/** Sums decimal strings, propagating null. Money never goes through a float. */
function sum(values: (string | null)[]): string | null {
  let total = 0n;
  const SCALE = 100_000_000n; // eight places, matching the database columns

  for (const value of values) {
    if (value === null) return null;
    const negative = value.trimStart().startsWith('-');
    const [whole = '0', fraction = ''] = value.replace('-', '').split('.');
    const padded = (fraction + '00000000').slice(0, 8);
    const scaled = BigInt(whole) * SCALE + BigInt(padded || '0');
    total += negative ? -scaled : scaled;
  }

  const negative = total < 0n;
  const absolute = negative ? -total : total;
  const whole = absolute / SCALE;
  const fraction = (absolute % SCALE).toString().padStart(8, '0');
  return `${negative ? '-' : ''}${whole.toString()}.${fraction}`;
}

export function combine(portfolios: PortfolioSummary[]): Combined {
  const caveats: string[] = [];

  const currencies = new Set(portfolios.map((p) => p.baseCurrency));
  const baseCurrency = currencies.size === 1 ? (portfolios[0]?.baseCurrency ?? null) : null;
  if (currencies.size > 1) {
    caveats.push(
      `These portfolios are held in ${[...currencies].join(' and ')}. ` +
        'Nothing here converts between currencies, so they are not added up.',
    );
  }

  const canAdd = baseCurrency !== null;
  const field = (pick: (p: PortfolioSummary) => string | null) =>
    canAdd ? sum(portfolios.map(pick)) : null;

  const equity = field((p) => p.equity);
  if (canAdd && equity === null) {
    caveats.push(
      'At least one of these has positions the platform could not mark, so the ' +
        'combined account value is not known. It is left blank rather than ' +
        'reported as the sum of the rest.',
    );
  }

  const dailyPnl = field((p) => p.dailyPnl);
  if (canAdd && dailyPnl === null) {
    caveats.push(
      'At least one of these has no earlier snapshot to measure today against, so ' +
        'there is no combined figure for the day.',
    );
  }

  return {
    baseCurrency,
    cashBalance: field((p) => p.cashBalance),
    positionsValue: field((p) => p.positionsValue),
    equity,
    initialCapital: field((p) => p.initialCapital),
    dailyPnl,
    openPositions: portfolios.reduce((n, p) => n + p.openPositions, 0),
    count: portfolios.length,
    caveats,
  };
}
