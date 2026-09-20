import { useMutation, useQueryClient } from '@tanstack/react-query';
import { PackagePlus } from 'lucide-react';
import { useState } from 'react';
import { AddInstrument } from '@/components/AddInstrument';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { api, explainApiError } from '@/lib/api';

/**
 * Recording shares that were already owned.
 *
 * Every other position in this system exists because a fill created it, which
 * is what makes each one traceable to a decision. These never can be, so the
 * form says what it is doing to the books rather than quietly doing it: the
 * value arrives as a transfer in, so it counts towards what you own and never
 * towards what you earned.
 */
export function ImportPosition({
  portfolioId,
  canWrite,
}: {
  portfolioId: string;
  canWrite: boolean;
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [symbol, setSymbol] = useState('');
  const [quantity, setQuantity] = useState('');
  const [price, setPrice] = useState('');
  const [acquired, setAcquired] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [unknown, setUnknown] = useState<string | null>(null);

  const submit = useMutation({
    mutationFn: () =>
      api<{ detail: string }>(`/api/portfolios/${portfolioId}/positions/import`, {
        method: 'POST',
        body: {
          symbol,
          quantity,
          averageEntryPrice: price,
          acquiredAt: new Date(`${acquired}T15:00:00Z`).toISOString(),
        },
      }),
    onSuccess: async () => {
      setError(null);
      setUnknown(null);
      setSymbol('');
      setQuantity('');
      setPrice('');
      setAcquired('');
      await queryClient.invalidateQueries({ queryKey: ['positions'] });
      await queryClient.invalidateQueries({ queryKey: ['portfolios'] });
    },
    onError: (err: Error) => {
      const message = explainApiError(err);
      setError(message);
      // Remembered separately from the error so the offer, and its answer,
      // survive the error being cleared.
      setUnknown(
        /is not an instrument this platform knows/i.test(message)
          ? symbol.trim().toUpperCase()
          : null,
      );
    },
  });

  if (!canWrite) return null;

  const ready = symbol.trim() && Number(quantity) > 0 && Number(price) > 0 && acquired;

  return (
    <Card>
      <CardHeader className="flex-row items-center gap-2">
        <PackagePlus className="h-3.5 w-3.5 text-sky-400" aria-hidden />
        <CardTitle>Shares you already own</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-xs">
        {!open ? (
          <>
            <p className="text-muted-foreground">
              Hold something bought elsewhere, before this platform was watching? Record it here
              with the price you actually paid, so it shows up in your positions and your risk
              checks.
            </p>
            <Button size="sm" variant="outline" className="w-full" onClick={() => setOpen(true)}>
              Record a holding
            </Button>
          </>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-2">
              <label className="block space-y-1">
                <span className="block text-[10px] uppercase tracking-wider text-muted-foreground">
                  Symbol
                </span>
                <Input
                  id="import-symbol"
                  className="h-8 text-xs"
                  aria-label="Symbol to import"
                  placeholder="AAPL"
                  value={symbol}
                  onChange={(e) => setSymbol(e.target.value.toUpperCase())}
                />
              </label>
              <label className="block space-y-1">
                <span className="block text-[10px] uppercase tracking-wider text-muted-foreground">
                  Shares
                </span>
                <Input
                  id="import-quantity"
                  className="h-8 text-xs tabular-nums"
                  aria-label="Shares held"
                  inputMode="decimal"
                  placeholder="50"
                  value={quantity}
                  onChange={(e) => setQuantity(e.target.value)}
                />
              </label>
              <label className="block space-y-1">
                <span className="block text-[10px] uppercase tracking-wider text-muted-foreground">
                  Price paid, per share
                </span>
                <Input
                  id="import-price"
                  className="h-8 text-xs tabular-nums"
                  aria-label="Average price paid"
                  inputMode="decimal"
                  placeholder="180.00"
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                />
              </label>
              <label className="block space-y-1">
                <span className="block text-[10px] uppercase tracking-wider text-muted-foreground">
                  Date acquired
                </span>
                <Input
                  id="import-acquired"
                  className="h-8 text-xs"
                  aria-label="Date acquired"
                  type="date"
                  value={acquired}
                  onChange={(e) => setAcquired(e.target.value)}
                />
              </label>
            </div>

            <p className="text-[11px] text-muted-foreground">
              This spends none of your cash and creates no order. Its value is recorded as arriving
              from outside, so it counts towards what you own and never towards what you earned —
              importing shares cannot improve your returns.
            </p>

            {error && (
              <p className="rounded-md border border-red-500/30 bg-red-500/5 p-2 text-[11px] text-red-400">
                {error}
              </p>
            )}

            {/*
              Kept in its own state rather than read from the error, which is
              what made the confirmation invisible: clearing the error on
              success unmounted the very component that was about to report it,
              so a click made the red box vanish and nothing took its place.

              Offered where the wall is hit. The moment somebody is told a
              ticker is unknown is the moment they want to fix it, and sending
              them to a settings page is how a two-click task becomes an
              abandoned one.
            */}
            {unknown && (
              <AddInstrument
                symbol={unknown}
                onAdded={() => {
                  setError(null);
                }}
              />
            )}
            {submit.data && (
              <p className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-2 text-[11px] text-emerald-300">
                {submit.data.detail}
              </p>
            )}

            <div className="flex gap-2">
              <Button
                size="sm"
                className="flex-1"
                disabled={!ready || submit.isPending}
                onClick={() => submit.mutate()}
              >
                {submit.isPending ? 'Recording…' : 'Record it'}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
