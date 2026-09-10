import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatMoney, formatPrice, formatQuantity, formatSignedMoney, pnlTone } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { Position } from '@/lib/types';

export function PositionsTable({ portfolioId }: { portfolioId: string }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['positions', portfolioId],
    queryFn: () => api<Position[]>(`/api/portfolios/${portfolioId}/positions`),
    refetchInterval: 10_000,
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Open positions</CardTitle>
      </CardHeader>
      <CardContent className="px-0 pb-0">
        {isLoading && <p className="px-4 pb-4 text-sm text-muted-foreground">Loading positions…</p>}
        {error && <p className="px-4 pb-4 text-sm text-loss">Could not load positions.</p>}
        {data?.length === 0 && (
          <p className="px-4 pb-4 text-sm text-muted-foreground">No open positions.</p>
        )}

        {data && data.length > 0 && (
          <>
            {/* Desktop: a dense table. */}
            <div className="hidden overflow-x-auto sm:block">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-[11px] uppercase tracking-wider text-muted-foreground">
                    <th className="px-4 py-2 text-left font-semibold">Symbol</th>
                    <th className="px-4 py-2 text-right font-semibold">Qty</th>
                    <th className="px-4 py-2 text-right font-semibold">Entry</th>
                    <th className="px-4 py-2 text-right font-semibold">Mark</th>
                    <th className="px-4 py-2 text-right font-semibold">Value</th>
                    <th className="px-4 py-2 text-right font-semibold">Unrealised</th>
                  </tr>
                </thead>
                <tbody>
                  {data.map((position) => (
                    <tr key={position.id} className="border-b border-border/60 last:border-0">
                      <td className="px-4 py-2 font-mono font-medium">{position.symbol}</td>
                      <td className="px-4 py-2 text-right tabular">
                        {formatQuantity(position.quantity)}
                      </td>
                      <td className="px-4 py-2 text-right tabular">
                        {formatPrice(position.averageEntryPrice)}
                      </td>
                      <td className="px-4 py-2 text-right tabular">
                        {position.markPrice === null ? (
                          <span className="text-muted-foreground" title="No market-data source">
                            unmarked
                          </span>
                        ) : (
                          formatPrice(position.markPrice)
                        )}
                      </td>
                      <td className="px-4 py-2 text-right tabular">
                        {formatMoney(position.marketValue)}
                      </td>
                      <td
                        className={cn(
                          'px-4 py-2 text-right font-medium tabular',
                          pnlTone(position.unrealizedPnl),
                        )}
                      >
                        {formatSignedMoney(position.unrealizedPnl)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Mobile: one card per position, P&L first. */}
            <ul className="divide-y divide-border sm:hidden">
              {data.map((position) => (
                <li key={position.id} className="flex items-center justify-between gap-3 px-4 py-3">
                  <div className="min-w-0">
                    <p className="font-mono font-medium">{position.symbol}</p>
                    <p className="text-xs text-muted-foreground tabular">
                      {formatQuantity(position.quantity)} @{' '}
                      {formatPrice(position.averageEntryPrice)}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className={cn('font-semibold tabular', pnlTone(position.unrealizedPnl))}>
                      {formatSignedMoney(position.unrealizedPnl)}
                    </p>
                    <p className="text-xs text-muted-foreground tabular">
                      {formatMoney(position.marketValue)}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </CardContent>
    </Card>
  );
}
