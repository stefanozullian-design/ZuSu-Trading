import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { AddInstrument } from '@/components/AddInstrument';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuth } from '@/hooks/useAuth';
import { ApiError, api, explainApiError } from '@/lib/api';
import { cn } from '@/lib/utils';
import type { RecordedTrade, RecordedTradeType } from '@/lib/types';

/**
 * Typing in what was done at the broker.
 *
 * Most of these portfolios are not held here — the tool says what is worth
 * doing, the person acts at their brokerage, and the book has to be brought
 * back into line afterwards. That is a data-entry job done in a hurry, months
 * of it at a time, so the form is built for the second entry rather than the
 * first: the type stays selected, the date stays put, and only the fields that
 * change are cleared.
 *
 * The fields shown follow the type, because a deposit has no share price and
 * offering one invites an entry the server will reject. The server rejects
 * those combinations anyway; this just avoids asking for them.
 */

const TYPES: { value: RecordedTradeType; label: string; hint: string }[] = [
  { value: 'BUY', label: 'Buy', hint: 'Shares bought. Cash goes down, the holding goes up.' },
  {
    value: 'SELL',
    label: 'Sell',
    hint: 'Shares sold. The gain is computed against the oldest lots first.',
  },
  {
    value: 'DIVIDEND',
    label: 'Dividend',
    hint: 'Cash the holdings paid. It counts towards what you earned.',
  },
  {
    value: 'DEPOSIT',
    label: 'Deposit',
    hint: 'Money paid in. It raises what you own and never what you earned.',
  },
  {
    value: 'WITHDRAWAL',
    label: 'Withdrawal',
    hint: 'Money taken out. It lowers what you own and is never a loss.',
  },
];

const SHARE_TYPES: RecordedTradeType[] = ['BUY', 'SELL'];

/** Today, as the value a date input wants. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * A date alone is not an instant. Midday UTC is used rather than midnight so
 * that the entry lands on the day it was meant to in every timezone this is
 * read from — a midnight stamp reads as the previous day west of Greenwich.
 */
function asInstant(date: string): string {
  return new Date(`${date}T12:00:00.000Z`).toISOString();
}

export function RecordTrade({ portfolioId }: { portfolioId: string }) {
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const [type, setType] = useState<RecordedTradeType>('BUY');
  const [symbol, setSymbol] = useState('');
  const [quantity, setQuantity] = useState('');
  const [price, setPrice] = useState('');
  const [amount, setAmount] = useState('');
  const [fees, setFees] = useState('');
  const [occurredOn, setOccurredOn] = useState(today);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [unknownSymbol, setUnknownSymbol] = useState<string | null>(null);
  const [recorded, setRecorded] = useState<RecordedTrade | null>(null);

  const isShares = SHARE_TYPES.includes(type);
  const selected = TYPES.find((option) => option.value === type);
  // Hidden rather than disabled for a reader: an entry form they cannot submit
  // is an invitation to type a month of a statement into a 403.
  const canRecord = can('portfolio:write');

  function switchType(next: RecordedTradeType) {
    setType(next);
    setError(null);
    setUnknownSymbol(null);
    // The fields the new type cannot carry would otherwise be sent and
    // refused — the server treats a deposit with a share count as a
    // contradiction rather than guessing which half was meant.
    if (SHARE_TYPES.includes(next)) {
      setAmount('');
    } else {
      setQuantity('');
      setPrice('');
      setFees('');
      if (next !== 'DIVIDEND') setSymbol('');
    }
  }

  const record = useMutation({
    mutationFn: () =>
      api<RecordedTrade>(`/api/portfolios/${portfolioId}/trades`, {
        method: 'POST',
        body: {
          type,
          occurredAt: asInstant(occurredOn),
          ...(symbol.trim() && (isShares || type === 'DIVIDEND')
            ? { symbol: symbol.trim().toUpperCase() }
            : {}),
          ...(isShares ? { quantity: quantity.trim(), price: price.trim() } : {}),
          ...(isShares && fees.trim() ? { fees: fees.trim() } : {}),
          ...(isShares ? {} : { amount: amount.trim() }),
          ...(note.trim() ? { note: note.trim() } : {}),
        },
      }),
    onSuccess: async (result) => {
      setError(null);
      setUnknownSymbol(null);
      setRecorded(result);
      // Everything downstream of a trade: the holding, the cash, the history,
      // and the portfolio header that shows the balance.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['positions', portfolioId] }),
        queryClient.invalidateQueries({ queryKey: ['trades', portfolioId] }),
        queryClient.invalidateQueries({ queryKey: ['portfolios'] }),
        queryClient.invalidateQueries({ queryKey: ['portfolio', portfolioId] }),
      ]);
      // The quantities change every time; the type and the date usually do
      // not, and re-picking them for each of a month's entries is the tax this
      // form exists to avoid.
      setQuantity('');
      setPrice('');
      setAmount('');
      setFees('');
      setNote('');
    },
    onError: (err: Error) => {
      const message = explainApiError(err);
      setRecorded(null);
      setError(message);
      // The one error with a fix available right here.
      setUnknownSymbol(
        err instanceof ApiError && /not an instrument this platform knows/.test(message)
          ? symbol.trim().toUpperCase()
          : null,
      );
    },
  });

  const ready =
    occurredOn.trim() !== '' &&
    (isShares
      ? symbol.trim() !== '' && quantity.trim() !== '' && price.trim() !== ''
      : amount.trim() !== '');

  if (!canRecord) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Record what you did</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          For portfolios held elsewhere. Enter the trade after you have made it at your broker and
          the book here stays in step. Nothing is sent to any broker.
        </p>

        <div className="flex flex-wrap gap-1">
          {TYPES.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => switchType(option.value)}
              className={cn(
                'rounded-md border px-2.5 py-1 text-xs font-medium transition-colors',
                type === option.value
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-border text-muted-foreground hover:text-foreground',
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
        {selected && <p className="text-[11px] text-muted-foreground">{selected.hint}</p>}

        <div className="grid gap-3 sm:grid-cols-2">
          {(isShares || type === 'DIVIDEND') && (
            <div className="space-y-1">
              <Label htmlFor="record-symbol">
                Symbol{type === 'DIVIDEND' ? ' (optional)' : ''}
              </Label>
              <Input
                id="record-symbol"
                value={symbol}
                autoComplete="off"
                placeholder="AAPL"
                onChange={(event) => setSymbol(event.target.value.toUpperCase())}
              />
            </div>
          )}

          {isShares && (
            <>
              <div className="space-y-1">
                <Label htmlFor="record-quantity">Shares</Label>
                <Input
                  id="record-quantity"
                  value={quantity}
                  inputMode="decimal"
                  placeholder="10"
                  onChange={(event) => setQuantity(event.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="record-price">Price per share</Label>
                <Input
                  id="record-price"
                  value={price}
                  inputMode="decimal"
                  placeholder="180.25"
                  onChange={(event) => setPrice(event.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="record-fees">Fees (optional)</Label>
                <Input
                  id="record-fees"
                  value={fees}
                  inputMode="decimal"
                  placeholder="0"
                  onChange={(event) => setFees(event.target.value)}
                />
              </div>
            </>
          )}

          {!isShares && (
            <div className="space-y-1">
              <Label htmlFor="record-amount">Amount</Label>
              <Input
                id="record-amount"
                value={amount}
                inputMode="decimal"
                placeholder="250.00"
                onChange={(event) => setAmount(event.target.value)}
              />
            </div>
          )}

          <div className="space-y-1">
            <Label htmlFor="record-date">Date it happened</Label>
            <Input
              id="record-date"
              type="date"
              value={occurredOn}
              max={today()}
              onChange={(event) => setOccurredOn(event.target.value)}
            />
          </div>

          <div className="space-y-1 sm:col-span-2">
            <Label htmlFor="record-note">Note (optional)</Label>
            <Input
              id="record-note"
              value={note}
              placeholder="Where it was done, why, anything you want to find later"
              onChange={(event) => setNote(event.target.value)}
            />
          </div>
        </div>

        <Button
          size="sm"
          disabled={!ready || record.isPending}
          onClick={() => {
            setRecorded(null);
            record.mutate();
          }}
        >
          {record.isPending ? 'Recording…' : 'Record it'}
        </Button>

        {error && <p className="text-[11px] text-red-400">{error}</p>}
        {unknownSymbol && (
          <AddInstrument
            symbol={unknownSymbol}
            onAdded={() => {
              // Deliberately does not clear the error: the message and the
              // confirmation sit together, so it reads as "that was the
              // problem, and it is fixed now".
              setUnknownSymbol(null);
            }}
          />
        )}

        {recorded && (
          <div className="space-y-1 rounded-md border border-emerald-500/30 bg-emerald-500/5 p-2">
            <p className="text-[11px] text-emerald-300">{recorded.detail}</p>
            {recorded.warnings.map((warning) => (
              <p key={warning} className="text-[11px] text-amber-300">
                {warning}
              </p>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
