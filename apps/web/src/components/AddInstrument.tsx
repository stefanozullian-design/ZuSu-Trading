import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, explainApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';

interface Added {
  symbol: string;
  name: string | null;
  candleCount: number;
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
      <p className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-2 text-[11px] text-emerald-300">
        Added {added.symbol}
        {added.name ? ` — ${added.name}` : ''}.{' '}
        {added.candleCount > 0
          ? `${String(added.candleCount)} days of history fetched. You can record the holding now.`
          : // Said rather than hidden: the instrument exists and cannot yet be
            // charted or marked, and the reason is the backfill, not the symbol.
            'No history came back yet, so it will show a dash until the next sync fills it in.'}
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
