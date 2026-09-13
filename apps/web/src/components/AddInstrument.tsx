import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, explainApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';

interface Added {
  symbol: string;
  name: string | null;
  candleCount: number;
  /** Whether a paper portfolio can put a price on it yet. */
  markable: boolean;
}

/**
 * Teaching the platform a symbol it does not know.
 *
 * Offered where the wall is hit rather than on a settings page somewhere: the
 * moment a person is told a ticker is unknown is the moment they want to fix
 * it, and sending them elsewhere to do it is how a two-click task becomes an
 * abandoned one.
 *
 * The provider decides whether the symbol exists. Nothing here writes down
 * whatever was typed — an instrument this platform cannot price is worse than
 * an absent one, because it charts as a gap and fails every risk check with a
 * message about missing data rather than about a symbol that was never real.
 */
export function AddInstrument({
  symbol,
  onAdded,
}: {
  symbol: string;
  onAdded: (symbol: string) => void;
}) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<Added | null>(null);

  const add = useMutation({
    mutationFn: () =>
      api<Added>('/api/market-data/instruments', {
        method: 'POST',
        body: { symbol: symbol.trim().toUpperCase() },
      }),
    onSuccess: async (instrument) => {
      setError(null);
      setAdded(instrument);
      await queryClient.invalidateQueries({ queryKey: ['instruments'] });
      onAdded(instrument.symbol);
    },
    onError: (err: Error) => setError(explainApiError(err)),
  });

  if (added) {
    return (
      <p
        className={
          added.markable
            ? 'rounded-md border border-emerald-500/30 bg-emerald-500/5 p-2 text-[11px] text-emerald-300'
            : 'rounded-md border border-amber-500/30 bg-amber-500/5 p-2 text-[11px] text-amber-300'
        }
      >
        Added {added.symbol}
        {added.name ? ` — ${added.name}` : ''}.{' '}
        {added.markable
          ? `${String(added.candleCount)} bars fetched. Press "Record it" to add the holding.`
          : // Said rather than left to be discovered: the symbol exists, the
            // holding can be recorded, and it will show a dash for a price
            // until intraday bars arrive. Reporting plain success here would
            // make that dash look like a broken price.
            'No intraday bars came back, so it will show “unmarked” until the next sync brings some. You can record the holding now either way.'}
      </p>
    );
  }

  return (
    <div className="space-y-1">
      <Button
        size="sm"
        variant="outline"
        disabled={add.isPending || symbol.trim().length === 0}
        onClick={() => add.mutate()}
      >
        {add.isPending
          ? `Looking up ${symbol.trim().toUpperCase()}…`
          : `Look up ${symbol.trim().toUpperCase()} and add it`}
      </Button>
      {error && <p className="text-[11px] text-red-400">{error}</p>}
    </div>
  );
}
