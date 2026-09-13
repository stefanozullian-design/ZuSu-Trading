import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useOwnerFilter } from './useOwnerFilter';
import type { PortfolioSummary } from '@/lib/types';

/**
 * The portfolios in scope, everywhere.
 *
 * Every page used to fetch the whole list independently, so choosing an owner
 * on the dashboard and clicking through to Trading put somebody else's books
 * back in the selector. That is not merely untidy here: the Trading page is
 * where an order gets approved, and a selector offering your own book while
 * you are thinking about a relative's is a way to commit the wrong one.
 *
 * So the owner filter is part of the fetch and part of the cache key. Without
 * the key, switching owner would show the previous person's portfolios from
 * cache until the refetch landed — someone else's book under the name you just
 * chose, which is the same mistake arriving a second later.
 */
export function usePortfolios(options: { includeClosed?: boolean } = {}): {
  portfolios: PortfolioSummary[] | undefined;
  isLoading: boolean;
  error: unknown;
  ownerId: string | null;
} {
  const { ownerId, query } = useOwnerFilter();
  const includeClosed = options.includeClosed ?? false;

  const { data, isLoading, error } = useQuery({
    queryKey: ['portfolios', includeClosed, ownerId],
    queryFn: () =>
      api<PortfolioSummary[]>(
        `/api/portfolios?includeClosed=${includeClosed ? 'true' : 'false'}${query}`,
      ),
    refetchInterval: 15_000,
  });

  return { portfolios: data, isLoading, error, ownerId };
}
