import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, RefreshCw, ShieldQuestion, X } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { useAuth } from '@/hooks/useAuth';
import { api, explainApiError } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { OrderRow, PortfolioSummary, PositionWithLots, SignalRow } from '@/lib/types';

/**
 * Trading.
 *
 * This page is where the platform's premise is visible: a recommendation sits
 * there until a person approves it. There is no "approve all", no automatic
 * sweep, and no setting that creates one — full automation is not a feature
 * switch here, it is a thing that does not exist.
 *
 * A rejection needs a reason for the same purpose the approval needs a person:
 * both are evidence about a strategy, and the pair is what makes a review
 * later worth anything.
 */
export function TradingPage() {
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const canApprove = can('signal:approve');

  const [portfolioId, setPortfolioId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [expanded, setExpanded] = useState<string | null>(null);

  const { data: portfolios } = useQuery({
    queryKey: ['portfolios'],
    queryFn: () => api<PortfolioSummary[]>('/api/portfolios'),
  });

  const id = portfolioId || (portfolios?.[0]?.id ?? '');

  const { data: signals } = useQuery({
    queryKey: ['signals', id],
    queryFn: () => api<{ signals: SignalRow[] }>(`/api/strategies/signals?portfolioId=${id}`),
    enabled: Boolean(id),
    refetchInterval: 20_000,
  });

  const { data: orders } = useQuery({
    queryKey: ['orders', id],
    queryFn: () => api<{ orders: OrderRow[] }>(`/api/trading/orders?portfolioId=${id}`),
    enabled: Boolean(id),
    refetchInterval: 20_000,
  });

  const { data: positions } = useQuery({
    queryKey: ['positions', id],
    queryFn: () =>
      api<{ positions: PositionWithLots[] }>(
        `/api/trading/positions?portfolioId=${id}&includeClosed=true`,
      ),
    enabled: Boolean(id),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['signals'] });
    void queryClient.invalidateQueries({ queryKey: ['orders'] });
    void queryClient.invalidateQueries({ queryKey: ['positions'] });
    void queryClient.invalidateQueries({ queryKey: ['portfolios'] });
  };

  const approve = useMutation({
    mutationFn: ({ signalId, quantity }: { signalId: string; quantity?: string }) =>
      api<OrderRow>(`/api/trading/signals/${signalId}/approve`, {
        method: 'POST',
        body: quantity ? { quantity } : {},
      }),
    onSuccess: () => {
      setError(null);
      invalidate();
    },
    onError: (err: Error) => setError(explainApiError(err)),
  });

  const reject = useMutation({
    mutationFn: ({ signalId, reason }: { signalId: string; reason: string }) =>
      api<{ id: string }>(`/api/trading/signals/${signalId}/reject`, {
        method: 'POST',
        body: { reason },
      }),
    onSuccess: () => {
      setError(null);
      invalidate();
    },
    onError: (err: Error) => setError(explainApiError(err)),
  });

  const sync = useMutation({
    mutationFn: (orderId: string) =>
      api<OrderRow>(`/api/trading/orders/${orderId}/sync`, { method: 'POST' }),
    onSuccess: () => {
      setError(null);
      invalidate();
    },
    onError: (err: Error) => setError(explainApiError(err)),
  });

  const waiting = (signals?.signals ?? []).filter(
    (signal) => signal.status === 'CREATED' || signal.status === 'PENDING_APPROVAL',
  );

  return (
    <main className="mx-auto w-full max-w-7xl space-y-3 px-3 py-4 sm:px-6">
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-xs text-muted-foreground" htmlFor="trading-portfolio">
          Portfolio
        </label>
        <select
          id="trading-portfolio"
          className="rounded-md border border-input bg-background px-2 py-1 text-xs"
          value={id}
          onChange={(e) => setPortfolioId(e.target.value)}
        >
          {(portfolios ?? []).map((portfolio) => (
            <option key={portfolio.id} value={portfolio.id}>
              {portfolio.name} · {portfolio.environment}
            </option>
          ))}
        </select>
      </div>

      {error && (
        <p className="rounded-md border border-red-500/30 bg-red-500/5 p-2 text-xs text-red-400">
          {error}
        </p>
      )}

      <Card>
        <CardHeader className="flex-row items-center gap-2">
          <ShieldQuestion className="h-3.5 w-3.5 text-sky-400" aria-hidden />
          <CardTitle>
            {waiting.length} recommendation{waiting.length === 1 ? '' : 's'} awaiting a decision
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {waiting.length === 0 && (
            <p className="text-xs text-muted-foreground">
              Nothing waiting. A signal appears here when a live strategy produces one, and stays
              until somebody decides — nothing sweeps this queue automatically.
            </p>
          )}

          {waiting.map((signal) => (
            <div key={signal.id} className="rounded-md border border-border p-2">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="font-medium">{signal.symbol}</span>
                <span className="text-muted-foreground">{signal.direction}</span>
                <span className="tabular-nums text-muted-foreground">
                  at {signal.referencePrice}
                  {signal.suggestedStop && <> · stop {signal.suggestedStop}</>}
                  {signal.suggestedTarget && <> · target {signal.suggestedTarget}</>}
                </span>
                <Badge className="ml-auto">{signal.status}</Badge>
              </div>
              <p className="mt-1 text-[11px] text-muted-foreground">
                {signal.strategyName}
                {signal.strategyVersion !== null && ` v${String(signal.strategyVersion)}`} ·{' '}
                {formatDateTime(signal.createdAt)}
              </p>

              {canApprove ? (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <Input
                    className="h-8 w-24 text-xs tabular-nums"
                    aria-label={`Quantity for ${signal.symbol}`}
                    placeholder="shares"
                    inputMode="numeric"
                    value={quantities[signal.id] ?? ''}
                    onChange={(e) => setQuantities({ ...quantities, [signal.id]: e.target.value })}
                  />
                  <Button
                    size="sm"
                    disabled={approve.isPending}
                    onClick={() =>
                      approve.mutate({
                        signalId: signal.id,
                        ...(quantities[signal.id] ? { quantity: quantities[signal.id] } : {}),
                      })
                    }
                  >
                    <Check className="mr-1 h-3.5 w-3.5" aria-hidden />
                    Approve
                  </Button>

                  <Input
                    className="h-8 min-w-40 flex-1 text-xs"
                    aria-label={`Reason for rejecting ${signal.symbol}`}
                    placeholder="Reason, if rejecting"
                    value={reasons[signal.id] ?? ''}
                    onChange={(e) => setReasons({ ...reasons, [signal.id]: e.target.value })}
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={reject.isPending || (reasons[signal.id] ?? '').trim().length < 4}
                    onClick={() =>
                      reject.mutate({
                        signalId: signal.id,
                        reason: reasons[signal.id] ?? '',
                      })
                    }
                  >
                    <X className="mr-1 h-3.5 w-3.5" aria-hidden />
                    Reject
                  </Button>
                </div>
              ) : (
                <p className="mt-2 text-[11px] text-amber-400">
                  Approving needs the <code>signal:approve</code> permission, which your role does
                  not include.
                </p>
              )}

              <p className="mt-1 text-[10px] text-muted-foreground">
                Approving sizes the order, runs the pre-trade checks and submits it. Blank quantity
                uses the strategy version&apos;s maximum notional.
              </p>
            </div>
          ))}
        </CardContent>
      </Card>

      <div className="grid gap-3 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Positions and their tax lots</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {(positions?.positions ?? []).length === 0 && (
              <p className="text-xs text-muted-foreground">No positions.</p>
            )}
            {(positions?.positions ?? []).map((position) => (
              <div key={position.id} className="rounded-md border border-border p-2 text-xs">
                <button
                  type="button"
                  className="flex w-full flex-wrap items-center gap-2 text-left"
                  onClick={() => setExpanded(expanded === position.id ? null : position.id)}
                  aria-expanded={expanded === position.id}
                >
                  <span className="font-medium">{position.symbol}</span>
                  <span className="tabular-nums text-muted-foreground">
                    {position.quantity} @ {Number(position.averageEntryPrice).toFixed(2)}
                  </span>
                  <Badge
                    className={cn(
                      'ml-auto',
                      position.status === 'CLOSED' && 'border-border text-muted-foreground',
                    )}
                  >
                    {position.status}
                  </Badge>
                </button>

                <p className="mt-1 tabular-nums text-muted-foreground">
                  realised {Number(position.realizedPnl).toFixed(2)} · unrealised{' '}
                  {position.unrealizedPnl === null
                    ? '— not priced'
                    : Number(position.unrealizedPnl).toFixed(2)}{' '}
                  · fees {Number(position.feesTotal).toFixed(2)}
                </p>

                {expanded === position.id && (
                  <table className="mt-2 w-full text-[11px]">
                    <thead>
                      <tr className="text-left uppercase tracking-wider text-muted-foreground">
                        <th className="py-1 pr-2">Opened</th>
                        <th className="py-1 pr-2">Qty</th>
                        <th className="py-1 pr-2">Remaining</th>
                        <th className="py-1 pr-2">Cost basis</th>
                        <th className="py-1 pr-2">Realised</th>
                      </tr>
                    </thead>
                    <tbody className="tabular-nums">
                      {position.lots.map((lot) => (
                        <tr key={lot.id} className="border-t border-border">
                          <td className="py-1 pr-2">{formatDateTime(lot.openedAt)}</td>
                          <td className="py-1 pr-2">{lot.quantity}</td>
                          <td className="py-1 pr-2">{lot.remainingQty}</td>
                          <td className="py-1 pr-2">{Number(lot.costBasis).toFixed(2)}</td>
                          <td className="py-1 pr-2">{Number(lot.realizedGain).toFixed(2)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            ))}
            <p className="text-[10px] text-muted-foreground">
              Each opening fill keeps its own lot and cost basis; a sale consumes lots oldest-first.
              An average price could not answer what was paid for which shares, or when.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Orders</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {(orders?.orders ?? []).length === 0 && (
              <p className="text-xs text-muted-foreground">No orders yet.</p>
            )}
            {(orders?.orders ?? []).map((order) => (
              <div key={order.id} className="rounded-md border border-border p-2 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{order.symbol}</span>
                  <span className="text-muted-foreground">
                    {order.side} {order.requestedQty} · {order.orderType}
                  </span>
                  <Badge
                    className={cn(
                      'ml-auto',
                      order.status === 'REJECTED' && 'border-red-500/40 text-red-400',
                      order.status === 'FILLED' && 'border-emerald-500/40 text-emerald-400',
                    )}
                  >
                    {order.status}
                  </Badge>
                  <button
                    type="button"
                    className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                    aria-label={`Sync ${order.symbol} order`}
                    onClick={() => sync.mutate(order.id)}
                  >
                    <RefreshCw className="h-3 w-3" aria-hidden />
                  </button>
                </div>

                <p className="mt-1 tabular-nums text-muted-foreground">
                  filled {order.filledQty}
                  {order.averageFillPrice && <> @ {Number(order.averageFillPrice).toFixed(4)}</>}
                  {order.slippage !== null && <> · slippage {Number(order.slippage).toFixed(4)}</>}
                  {Number(order.feesTotal) > 0 && <> · fees {Number(order.feesTotal).toFixed(2)}</>}
                </p>

                {order.rejectionReason && (
                  <p className="mt-1 text-[11px] text-amber-300">{order.rejectionReason}</p>
                )}
                <p className="text-[10px] text-muted-foreground">
                  {formatDateTime(order.createdAt)} · {order.environment}
                </p>
              </div>
            ))}
            <p className="text-[10px] text-muted-foreground">
              A refused order is kept with its reason, so &ldquo;why did this not trade&rdquo;
              always has an answer.
            </p>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
