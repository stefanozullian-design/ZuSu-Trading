import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, Brain, Check, Clock, PackagePlus, RefreshCw, ShieldQuestion, X } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { AddInstrument } from '@/components/AddInstrument';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { useAuth } from '@/hooks/useAuth';
import { useSelectedPortfolio } from '@/hooks/useSelectedPortfolio';
import { usePortfolios } from '@/hooks/usePortfolios';
import { api, explainApiError } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import type {
  AnalysisRow,
  AnalysisSpend,
  GateDecision,
  NotificationRow,
  OrderRow,
  PositionWithLots,
  SignalRow,
} from '@/lib/types';

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

  const [error, setError] = useState<string | null>(null);
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [expanded, setExpanded] = useState<string | null>(null);
  const canAnalyse = can('strategy:write');

  // Scoped to the owner chosen on the dashboard. A selector that offered
  // every book while a person was thinking about one relative's is a way to
  // commit the wrong one, and this is a page where that costs money.
  const { portfolios } = usePortfolios();

  const { selectedId: id, select: setPortfolioId } = useSelectedPortfolio(portfolios);

  const { data: signals, isPending: signalsPending } = useQuery({
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

  const { data: analyses } = useQuery({
    queryKey: ['analyses', id],
    queryFn: () =>
      api<{ analyses: AnalysisRow[]; spend: AnalysisSpend }>(
        `/api/analysis?portfolioId=${id}&limit=50`,
      ),
    enabled: Boolean(id),
  });

  const { data: notifications } = useQuery({
    queryKey: ['notifications'],
    queryFn: () => api<{ notifications: NotificationRow[] }>('/api/notifications?limit=20'),
    refetchInterval: 30_000,
  });

  const { data: positions } = useQuery({
    // Not ['positions', id] — the dashboard's table already owns that key for a
    // different endpoint returning a bare array. Sharing a key across two
    // shapes meant whichever page mounted first won the cache, and since the
    // dashboard is where everyone lands, this list read an array as an object
    // and rendered "No positions" over a book that was not empty. Distinct
    // keys; a ['positions'] invalidation still matches both as a prefix.
    queryKey: ['positions', 'with-lots', id],
    queryFn: () =>
      api<{ positions: PositionWithLots[] }>(
        `/api/trading/positions?portfolioId=${id}&includeClosed=true`,
      ),
    enabled: Boolean(id),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['signals'] });
    void queryClient.invalidateQueries({ queryKey: ['analyses'] });
    void queryClient.invalidateQueries({ queryKey: ['notifications'] });
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

  const analyse = useMutation({
    mutationFn: (signalId: string) =>
      api<{ refusal: string | null }>(`/api/analysis/signals/${signalId}`, { method: 'POST' }),
    onSuccess: (data) => {
      setError(data.refusal);
      invalidate();
    },
    onError: (err: Error) => setError(explainApiError(err)),
  });

  const dismiss = useMutation({
    mutationFn: (notificationId: string) =>
      api<null>(`/api/notifications/${notificationId}/dismiss`, { method: 'POST' }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['notifications'] }),
  });

  /** The newest analysis per signal, so the card shows the current advice. */
  const adviceFor = (signalId: string): AnalysisRow | undefined =>
    (analyses?.analyses ?? []).find((row) => row.signalId === signalId);

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

      <GateBanner portfolioId={id} />

      {error && (
        <p className="rounded-md border border-red-500/30 bg-red-500/5 p-2 text-xs text-red-400">
          {error}
        </p>
      )}

      <Card>
        <CardHeader className="flex-row items-center gap-2">
          <ShieldQuestion className="h-3.5 w-3.5 text-sky-400" aria-hidden />
          <CardTitle>
            {/*
              "0 recommendations awaiting a decision" while the queue is still
              loading is a lie with a short life and a real cost: this is the
              screen a person checks to decide whether anything needs them, and
              for a moment it told them no on no evidence.
            */}
            {signalsPending
              ? 'Loading what is awaiting a decision…'
              : `${String(waiting.length)} recommendation${waiting.length === 1 ? '' : 's'} awaiting a decision`}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {signalsPending && (
            <p className="text-xs text-muted-foreground">
              Asking the engine what is waiting. Nothing is hidden while this loads.
            </p>
          )}
          {!signalsPending && waiting.length === 0 && (
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

              <Advice
                analysis={adviceFor(signal.id)}
                canAnalyse={canAnalyse}
                pending={analyse.isPending}
                onAnalyse={() => analyse.mutate(signal.id)}
              />
            </div>
          ))}
        </CardContent>
      </Card>

      <div className="grid gap-3 lg:grid-cols-2">
        {analyses?.spend && <SpendCard spend={analyses.spend} />}

        <Card>
          <CardHeader className="flex-row items-center gap-2">
            <Bell className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
            <CardTitle>Notifications</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1.5">
            {(notifications?.notifications ?? []).length === 0 && (
              <p className="text-xs text-muted-foreground">
                Nothing waiting. Only two things are notified: something you have to decide, and
                something the platform refused to do.
              </p>
            )}
            {(notifications?.notifications ?? []).map((notification) => (
              <div
                key={notification.id}
                className="flex items-start gap-2 rounded-md border border-border p-2 text-xs"
              >
                <div className="min-w-0">
                  <p className="font-medium">{notification.title}</p>
                  <p className="text-[11px] text-muted-foreground">{notification.body}</p>
                  <p className="text-[10px] text-muted-foreground">
                    {formatDateTime(notification.createdAt)} · {notification.channel}
                  </p>
                </div>
                <button
                  type="button"
                  className="ml-auto rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                  aria-label={`Dismiss ${notification.title}`}
                  onClick={() => dismiss.mutate(notification.id)}
                >
                  <X className="h-3 w-3" aria-hidden />
                </button>
              </div>
            ))}
          </CardContent>
        </Card>

        <ImportPosition portfolioId={id} canWrite={can('portfolio:write')} />

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

/**
 * A model's advice on one recommendation.
 *
 * The disclaimer is on the card rather than in a footnote: an analysis has no
 * authority, and the place a person might forget that is exactly here, next to
 * the Approve button.
 */
function Advice({
  analysis,
  canAnalyse,
  pending,
  onAnalyse,
}: {
  analysis: AnalysisRow | undefined;
  canAnalyse: boolean;
  pending: boolean;
  onAnalyse: () => void;
}) {
  if (!analysis) {
    return canAnalyse ? (
      <Button
        variant="ghost"
        size="sm"
        className="mt-1 text-xs"
        disabled={pending}
        onClick={onAnalyse}
      >
        <Brain className="mr-1 h-3.5 w-3.5" aria-hidden />
        {pending ? 'Asking…' : 'Ask for an analysis'}
      </Button>
    ) : null;
  }

  if (!analysis.responseValid) {
    return (
      <p className="mt-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-2 text-[11px] text-amber-300">
        No analysis: {analysis.validationError}
      </p>
    );
  }

  return (
    <div className="mt-2 rounded-md border border-border bg-muted/20 p-2 text-[11px]">
      <div className="flex flex-wrap items-center gap-2">
        <Brain className="h-3 w-3 text-violet-400" aria-hidden />
        <span className="font-medium">{analysis.action}</span>
        <span className="text-muted-foreground">
          confidence {analysis.confidence ? Number(analysis.confidence).toFixed(2) : '—'} ·{' '}
          {analysis.riskLevel} risk
          {analysis.regime && <> · {analysis.regime.toLowerCase().replace('_', ' ')}</>}
        </span>
        <span className="ml-auto text-muted-foreground">
          {analysis.model}
          {analysis.costUsd && <> · ${Number(analysis.costUsd).toFixed(4)}</>}
        </span>
      </div>
      {analysis.rationale && <p className="mt-1">{analysis.rationale}</p>}
      {analysis.invalidation && (
        <p className="mt-1 text-muted-foreground">Wrong if: {analysis.invalidation}</p>
      )}
      {analysis.missingContext.length > 0 && (
        <p className="mt-1 text-muted-foreground">Missing: {analysis.missingContext.join(', ')}</p>
      )}
      <p className="mt-1 text-[10px] text-amber-400">
        Advice only. It cannot approve, size or place anything — this recommendation still waits for
        you.
      </p>
    </div>
  );
}

/** What the analysis layer has cost today, against its caps. */
function SpendCard({ spend }: { spend: AnalysisSpend }) {
  const spent = Number(spend.spentTodayUsd);
  const budget = Number(spend.limits.dailyUsd);
  const fraction = budget > 0 ? Math.min(1, spent / budget) : 0;

  return (
    <Card>
      <CardHeader className="flex-row items-center gap-2">
        <Brain className="h-3.5 w-3.5 text-violet-400" aria-hidden />
        <CardTitle>Analysis spend today</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {!spend.providerConfigured ? (
          <p className="text-xs text-amber-300">
            No analysis provider is configured, so no analysis can run. Nothing here will invent
            one: a fabricated opinion is worse than none, because you could not tell.
          </p>
        ) : (
          <>
            <p className="tabular-nums text-sm font-medium">
              ${spent.toFixed(4)}{' '}
              <span className="text-xs font-normal text-muted-foreground">
                of ${budget.toFixed(2)}
              </span>
            </p>
            <div
              className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
              role="img"
              aria-label={`${(fraction * 100).toFixed(0)}% of today's analysis budget used`}
            >
              <div
                className={cn(
                  'h-full rounded-full',
                  fraction > 0.8 ? 'bg-amber-400' : 'bg-sky-500',
                )}
                style={{ width: `${String(Math.max(1, fraction * 100))}%` }}
              />
            </div>
            <p className="text-[11px] text-muted-foreground">
              {spend.callsLastHour} of {spend.limits.callsPerHour} calls this hour ·{' '}
              {spend.providerName}
            </p>
          </>
        )}
        <p className="text-[10px] text-muted-foreground">
          A call that would cross the budget or the hourly ceiling is refused before the money is
          spent, and the refusal is recorded.
        </p>
      </CardContent>
    </Card>
  );
}

/**
 * Whether this portfolio can trade at all, stated before anyone clicks.
 *
 * The same decision the order manager enforces, read from the same endpoint.
 * Learning that the market is shut from a refusal *after* approving is the
 * kind of thing that makes people distrust a tool: the answer was knowable
 * the whole time, so it belongs at the top of the page.
 */
function GateBanner({ portfolioId }: { portfolioId: string }) {
  const { data: gate } = useQuery({
    queryKey: ['gate', portfolioId],
    queryFn: () => api<GateDecision>(`/api/risk/portfolios/${portfolioId}/gate`),
    enabled: Boolean(portfolioId),
    refetchInterval: 60_000,
  });

  if (!gate || gate.allowed) return null;

  // Only the blocking ones stop a submission. Listing a warning beside them
  // under "nothing can be submitted" would make a Redis that nobody installed
  // look like the reason a trade did not go through.
  const blocking = gate.blockers.filter((blocker) => blocker.severity === 'BLOCKING');
  const warnings = gate.blockers.filter((blocker) => blocker.severity !== 'BLOCKING');

  return (
    <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-2 text-xs text-amber-300">
      <p className="flex items-center gap-1.5 font-medium">
        <Clock className="h-3.5 w-3.5" aria-hidden />
        Nothing can be submitted right now
      </p>
      <ul className="mt-1 space-y-0.5 text-[11px]">
        {blocking.map((blocker) => (
          <li key={blocker.code + blocker.message}>· {blocker.message}</li>
        ))}
      </ul>
      <p className="mt-1 text-[11px] text-muted-foreground">
        The recommendations below stay where they are. Approving one now would be refused by the
        same check, so the refusal is shown here instead of after the click.
      </p>
      {warnings.length > 0 && (
        <p className="mt-1 text-[11px] text-muted-foreground">
          Also noted, but not what is stopping anything:{' '}
          {warnings.map((warning) => warning.message).join(' ')}
        </p>
      )}
    </div>
  );
}

/**
 * Recording shares that were already owned.
 *
 * Every other position in this system exists because a fill created it, which
 * is what makes each one traceable to a decision. These never can be, so the
 * form says what it is doing to the books rather than quietly doing it: the
 * value arrives as a transfer in, so it counts towards what you own and never
 * towards what you earned.
 */
function ImportPosition({ portfolioId, canWrite }: { portfolioId: string; canWrite: boolean }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [symbol, setSymbol] = useState('');
  const [quantity, setQuantity] = useState('');
  const [price, setPrice] = useState('');
  const [acquired, setAcquired] = useState('');
  const [error, setError] = useState<string | null>(null);

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
      setSymbol('');
      setQuantity('');
      setPrice('');
      setAcquired('');
      await queryClient.invalidateQueries({ queryKey: ['positions'] });
      await queryClient.invalidateQueries({ queryKey: ['portfolios'] });
    },
    onError: (err: Error) => setError(explainApiError(err)),
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
              <div className="space-y-2 rounded-md border border-red-500/30 bg-red-500/5 p-2">
                <p className="text-[11px] text-red-400">{error}</p>
                {/*
                  Offered where the wall is hit. The moment somebody is told a
                  ticker is unknown is the moment they want to fix it, and
                  sending them to a settings page to do it is how a two-click
                  task becomes an abandoned one.
                */}
                {/is not an instrument this platform knows/i.test(error) && (
                  <AddInstrument symbol={symbol} onAdded={() => setError(null)} />
                )}
              </div>
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
