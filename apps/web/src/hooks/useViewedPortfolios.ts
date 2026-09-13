import { useCallback } from 'react';
import { rememberedChoice, useRemembered } from './rememberedChoice';

/**
 * The portfolios shown together on the dashboard.
 *
 * Separate from the single selection every other page uses, and deliberately
 * so. Looking at several books at once is a reasonable way to answer "how is
 * this person doing"; *acting* on several at once is not. An approve button
 * that did not name exactly one portfolio would be the most dangerous control
 * in this application, so multi-selection stops at the dashboard and every
 * page that commits anything still deals with one book.
 */
const store = rememberedChoice('zusu.viewedPortfolioIds');

export function useViewedPortfolios(available: { id: string }[] | undefined): {
  /** Always at least one id, when anything is available at all. */
  viewedIds: string[];
  toggle: (id: string) => void;
  only: (id: string) => void;
  isViewed: (id: string) => boolean;
} {
  const { value, set } = useRemembered(store);

  const stored = value === null || value === '' ? [] : value.split(',');
  // Ids that are no longer available — closed, filtered out by owner, access
  // revoked — are dropped rather than silently counted into a total.
  const kept = stored.filter((id) => (available ?? []).some((p) => p.id === id));
  const viewedIds = kept.length > 0 ? kept : available?.[0] ? [available[0].id] : [];

  const toggle = useCallback(
    (id: string) => {
      const next = viewedIds.includes(id) ? viewedIds.filter((v) => v !== id) : [...viewedIds, id];
      // Never nothing: an empty dashboard with a portfolio list above it reads
      // as broken rather than as a choice.
      set(next.length === 0 ? viewedIds.join(',') : next.join(','));
    },
    [viewedIds, set],
  );

  const only = useCallback((id: string) => set(id), [set]);

  return {
    viewedIds,
    toggle,
    only,
    isViewed: (id: string) => viewedIds.includes(id),
  };
}
