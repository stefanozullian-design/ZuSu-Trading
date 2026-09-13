import { rememberedChoice, useRemembered } from './rememberedChoice';

/**
 * Which owner's portfolios to show, remembered across pages.
 *
 * Three states, and the third is the one worth naming: `null` shows everyone's,
 * an id shows that person's, and the literal `'none'` shows the portfolios with
 * nobody assigned. That last one is not a curiosity — it is how a person finds
 * the portfolio they forgot to assign, which would otherwise be invisible the
 * moment they started filtering.
 */
const store = rememberedChoice('zusu.ownerFilter');

export const UNASSIGNED = 'none';

export function useOwnerFilter(): {
  ownerId: string | null;
  setOwnerId: (id: string | null) => void;
  /** The query string fragment, empty when showing everyone's. */
  query: string;
} {
  const { value, set } = useRemembered(store);

  return {
    ownerId: value,
    setOwnerId: set,
    query: value === null ? '' : `&ownerId=${encodeURIComponent(value)}`,
  };
}
