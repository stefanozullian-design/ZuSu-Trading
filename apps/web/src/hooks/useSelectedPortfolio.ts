import { useCallback } from 'react';
import { rememberedChoice, useRemembered } from './rememberedChoice';

/**
 * The portfolio you are looking at, remembered across pages.
 *
 * Each page kept its own selection, so choosing a portfolio on the dashboard
 * and clicking through to Trading landed you back on whichever one happened to
 * be first. On a platform where the whole point is knowing which book you are
 * about to commit, a selector that silently resets is worse than an
 * inconvenience.
 */
const store = rememberedChoice('zusu.selectedPortfolioId');

/**
 * Returns the remembered id and a setter.
 *
 * `available` is the list of portfolios the caller can actually show. A
 * remembered id that is not in it — closed, revoked, filtered out by owner, or
 * belonging to another account — falls back to the first available rather than
 * selecting nothing.
 */
export function useSelectedPortfolio(available: { id: string }[] | undefined): {
  selectedId: string;
  select: (id: string) => void;
} {
  const { value, set } = useRemembered(store);

  const select = useCallback((id: string) => set(id), [set]);

  const isAvailable = value !== null && (available ?? []).some((p) => p.id === value);
  const selectedId = isAvailable ? value : (available?.[0]?.id ?? '');

  return { selectedId, select };
}
