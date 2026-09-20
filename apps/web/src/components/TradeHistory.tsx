import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { api } from '@/lib/api';
import { formatPrice, formatQuantity, formatSignedMoney, pnlTone } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { RecordedTradeType, TradeHistoryEntry } from '@/lib/types';

/**
 * What has been entered, newest first.
 *
 * Read from the ledger of entries rather than from positions and lots. Once a
 * sale has consumed a lot, nothing about today's holdings can say what was
 * bought in March or at what price — and "what did I enter, and did I enter it
 * twice" is the question this panel exists to answer, usually with a brokerage
 * statement open alongside.
 */

const LABELS: Record<RecordedTradeType, string> = {
  BUY: 'Buy',
  SELL: 'Sell',
  DIVIDEND: 'Dividend',
  DEPOSIT: 'Deposit',
  WITHDRAWAL: 'Withdrawal',
};

const TONES: Record<RecordedTradeType, string> = {
  BUY: 'text-sky-300',
  SELL: 'text-amber-300',
  DIVIDEND: 'text-emerald-300',
  DEPOSIT: 'text-muted-foreground',
  WITHDRAWAL: 'text-muted-foreground',
};

function describe(entry: TradeHistoryEntry): string {
  if (entry.quantity && entry.price) {
    return `${formatQuantity(entry.quantity)} ${entry.symbol ?? ''} @ ${formatPrice(entry.price)}`;
  }
  return entry.symbol ?? '—';
}

export function TradeHistory({ portfolioId }: { portfolioId: string }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['trades', portfolioId],
    queryFn: () => api<TradeHistoryEntry[]>(`/api/portfolios/${portfolioId}/trades?limit=50`),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Recorded history</CardTitle>
      </CardHeader>
      <CardContent className="px-0 pb-0">
        {isLoading && <p className="px-4 pb-4 text-sm text-muted-foreground">Loading history…</p>}
        {error && <p className="px-4 pb-4 text-sm text-loss">Could not load the history.</p>}
        {data?.length === 0 && (
          <p className="px-4 pb-4 text-sm text-muted-foreground">
            Nothing recorded yet. Entries you make appear here in the order they happened.
          </p>
        )}

        {data && data.length > 0 && (
          <ul className="divide-y divide-border">
            {data.map((entry) => (
              <li key={entry.id} className="flex items-start justify-between gap-3 px-4 py-2.5">
                <div className="min-w-0">
                  <p className="text-sm">
                    <span className={cn('font-medium', TONES[entry.type])}>
                      {LABELS[entry.type]}
                    </span>{' '}
                    <span className="font-mono text-muted-foreground">{describe(entry)}</span>
                  </p>
                  <p className="text-[11px] text-muted-foreground">
                    {entry.occurredAt.slice(0, 10)}
                    {entry.note ? ` · ${entry.note}` : ''}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <p className={cn('text-sm tabular', pnlTone(entry.cashDelta))}>
                    {formatSignedMoney(entry.cashDelta)}
                  </p>
                  {entry.realizedPnl !== null && (
                    <p className={cn('text-[11px] tabular', pnlTone(entry.realizedPnl))}>
                      {formatSignedMoney(entry.realizedPnl)} realised
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
