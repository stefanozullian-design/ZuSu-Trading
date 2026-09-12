import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Play, TriangleAlert } from 'lucide-react';
import { useMemo, useState } from 'react';
import { EquityCurve } from '@/components/backtest/EquityCurve';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { useAuth } from '@/hooks/useAuth';
import { api, explainApiError } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import type {
  BacktestDetail,
  BacktestMetrics,
  BacktestSummary,
  MonteCarloResult,
  Strategy,
  WalkForwardResult,
} from '@/lib/types';

/**
 * Backtests.
 *
 * The page is arranged around one idea: a backtest is a claim about the past,
 * and a claim arrives with its assumptions or it does not arrive. So the
 * modelling rules the engine applied are on screen next to the result, the
 * gross and net figures sit side by side, and the counts that qualify a result
 * — ambiguous exits, gaps through the stop, bars that could not be judged —
 * are shown rather than filed away.
 *
 * Nothing here changes a strategy. Optimisation ranks and warns; a person
 * decides what becomes a version.
 */
export function BacktestPage() {
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const canRun = can('backtest:write');

  const [versionId, setVersionId] = useState('');
  const [from, setFrom] = useState(defaultFrom());
  const [to, setTo] = useState(defaultTo());
  const [capital, setCapital] = useState('100000');
  const [commission, setCommission] = useState('1');
  const [spread, setSpread] = useState('0.00005');
  const [slippage, setSlippage] = useState('0.0002');
  const [thorough, setThorough] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data: strategies } = useQuery({
    queryKey: ['strategies'],
    queryFn: () => api<{ strategies: Strategy[] }>('/api/strategies'),
  });

  const { data: backtests } = useQuery({
    queryKey: ['backtests'],
    queryFn: () => api<{ backtests: BacktestSummary[] }>('/api/backtests?limit=25'),
  });

  const { data: detail } = useQuery({
    queryKey: ['backtest', selectedId],
    queryFn: () => api<BacktestDetail>(`/api/backtests/${selectedId ?? ''}`),
    enabled: Boolean(selectedId),
  });

  const versions = useMemo(
    () =>
      (strategies?.strategies ?? []).flatMap((strategy) =>
        strategy.versions
          .filter((version) => version.definition !== null)
          .map((version) => ({
            id: version.id,
            label: `${strategy.name} v${String(version.version)} · ${version.stage}`,
          })),
      ),
    [strategies],
  );

  const effectiveVersionId = versionId || (versions[0]?.id ?? '');

  const run = useMutation({
    mutationFn: () =>
      api<BacktestSummary>('/api/backtests', {
        method: 'POST',
        body: {
          strategyVersionId: effectiveVersionId,
          from: new Date(`${from}T00:00:00.000Z`).toISOString(),
          to: new Date(`${to}T23:59:59.000Z`).toISOString(),
          initialCapital: capital,
          quick: !thorough,
          costs: {
            commissionPerTrade: commission,
            spreadFraction: spread,
            slippageFraction: slippage,
          },
        },
      }),
    onSuccess: (summary) => {
      setError(null);
      setSelectedId(summary.id);
      void queryClient.invalidateQueries({ queryKey: ['backtests'] });
    },
    onError: (err: Error) => setError(explainApiError(err)),
  });

  return (
    <main className="mx-auto w-full max-w-7xl space-y-3 px-3 py-4 sm:px-6">
      <div className="grid gap-3 lg:grid-cols-[280px_minmax(0,1fr)]">
        <div className="space-y-3">
          {canRun && (
            <Card>
              <CardHeader>
                <CardTitle>Run a backtest</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <select
                  className="w-full rounded-md border border-input bg-background px-2 py-1 text-xs"
                  aria-label="Strategy version"
                  value={effectiveVersionId}
                  onChange={(e) => setVersionId(e.target.value)}
                >
                  {versions.length === 0 && <option value="">No readable version yet</option>}
                  {versions.map((version) => (
                    <option key={version.id} value={version.id}>
                      {version.label}
                    </option>
                  ))}
                </select>

                <div className="flex gap-2">
                  <Labelled label="From">
                    <Input
                      type="date"
                      className="h-8 text-xs"
                      aria-label="From"
                      value={from}
                      onChange={(e) => setFrom(e.target.value)}
                    />
                  </Labelled>
                  <Labelled label="To">
                    <Input
                      type="date"
                      className="h-8 text-xs"
                      aria-label="To"
                      value={to}
                      onChange={(e) => setTo(e.target.value)}
                    />
                  </Labelled>
                </div>

                <Labelled label="Starting capital">
                  <Input
                    className="h-8 text-xs tabular-nums"
                    aria-label="Starting capital"
                    inputMode="decimal"
                    value={capital}
                    onChange={(e) => setCapital(e.target.value)}
                  />
                </Labelled>

                <fieldset className="space-y-2 rounded-md border border-border p-2">
                  <legend className="px-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                    Costs
                  </legend>
                  <Labelled label="Commission per trade">
                    <Input
                      className="h-8 text-xs tabular-nums"
                      aria-label="Commission per trade"
                      inputMode="decimal"
                      value={commission}
                      onChange={(e) => setCommission(e.target.value)}
                    />
                  </Labelled>
                  <Labelled label="Half-spread (fraction of price)">
                    <Input
                      className="h-8 text-xs tabular-nums"
                      aria-label="Half spread"
                      inputMode="decimal"
                      value={spread}
                      onChange={(e) => setSpread(e.target.value)}
                    />
                  </Labelled>
                  <Labelled label="Slippage (fraction of price)">
                    <Input
                      className="h-8 text-xs tabular-nums"
                      aria-label="Slippage"
                      inputMode="decimal"
                      value={slippage}
                      onChange={(e) => setSlippage(e.target.value)}
                    />
                  </Labelled>
                  <p className="text-[10px] text-muted-foreground">
                    Setting these to zero produces a result nobody could have earned. They are
                    editable so you can see what they cost, not so they can be switched off.
                  </p>
                </fieldset>

                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={thorough}
                    onChange={(e) => setThorough(e.target.checked)}
                  />
                  Walk-forward and Monte Carlo
                </label>

                <Button
                  size="sm"
                  className="w-full"
                  disabled={run.isPending || !effectiveVersionId}
                  onClick={() => run.mutate()}
                >
                  <Play className="mr-1 h-3.5 w-3.5" aria-hidden />
                  {run.isPending ? 'Running…' : 'Run'}
                </Button>

                {error && (
                  <p className="rounded-md border border-red-500/30 bg-red-500/5 p-2 text-xs text-red-400">
                    {error}
                  </p>
                )}
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle>History</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1">
              {(backtests?.backtests ?? []).length === 0 && (
                <p className="text-xs text-muted-foreground">Nothing run yet.</p>
              )}
              {(backtests?.backtests ?? []).map((backtest) => (
                <button
                  key={backtest.id}
                  type="button"
                  onClick={() => setSelectedId(backtest.id)}
                  className={cn(
                    'w-full rounded-md px-2 py-1.5 text-left text-xs transition-colors',
                    selectedId === backtest.id
                      ? 'bg-muted text-foreground'
                      : 'text-muted-foreground hover:bg-muted/60',
                  )}
                  aria-current={selectedId === backtest.id}
                >
                  <span className="flex items-center gap-1.5">
                    <span className="truncate">
                      {backtest.strategyName} v{backtest.version}
                    </span>
                    <Badge
                      className={cn(
                        'ml-auto',
                        backtest.status === 'FAILED' && 'border-red-500/40 text-red-400',
                      )}
                    >
                      {backtest.status}
                    </Badge>
                  </span>
                  <span className="mt-0.5 block text-[11px]">
                    {backtest.metrics
                      ? `${Number(backtest.metrics.totalReturnPct).toFixed(1)}% · ${String(backtest.tradeCount)} trades`
                      : (backtest.errorMessage ?? '—')}
                  </span>
                </button>
              ))}
            </CardContent>
          </Card>
        </div>

        <div className="space-y-3">
          {!detail && (
            <Card>
              <CardContent className="py-12 text-center text-sm text-muted-foreground">
                Run a backtest, or pick one from the history.
              </CardContent>
            </Card>
          )}

          {detail?.status === 'FAILED' && (
            <Card>
              <CardHeader>
                <CardTitle>Run failed</CardTitle>
              </CardHeader>
              <CardContent className="text-xs text-amber-300">{detail.errorMessage}</CardContent>
            </Card>
          )}

          {detail?.metrics && (
            <>
              <Headline detail={detail} metrics={detail.metrics} />
              <EquityCurve
                points={detail.equityCurve}
                initialCapital={detail.initialCapital}
                timeframe={detail.timeframe}
              />
              <Caveats metrics={detail.metrics} />
              {detail.walkForward && <WalkForwardPanel result={detail.walkForward} />}
              {detail.monteCarlo && <MonteCarloPanel result={detail.monteCarlo} />}
              <Assumptions detail={detail} />
              <Trades detail={detail} />
            </>
          )}
        </div>
      </div>
    </main>
  );
}

function Labelled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="block text-[10px] uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      {children}
    </label>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="tabular-nums text-sm font-medium">{value}</p>
      {hint && <p className="text-[10px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** An unavailable statistic reads as unavailable, never as zero. */
function orDash(value: string | null, format: (v: string) => string): string {
  return value === null ? '—' : format(value);
}

const pct = (value: string) => `${Number(value).toFixed(2)}%`;
const money = (value: string) =>
  Number(value).toLocaleString(undefined, { maximumFractionDigits: 2 });

function Headline({ detail, metrics }: { detail: BacktestSummary; metrics: BacktestMetrics }) {
  return (
    <Card>
      <CardHeader className="flex-row items-baseline justify-between gap-2">
        <CardTitle>
          {detail.strategyName} v{detail.version} · {detail.timeframe}
        </CardTitle>
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
          {formatDateTime(detail.startDate)} → {formatDateTime(detail.endDate)}
        </span>
      </CardHeader>
      <CardContent className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Net return" value={pct(metrics.totalReturnPct)} hint="after every cost" />
        <Stat label="Net profit" value={money(metrics.netProfit)} />
        <Stat
          label="Gross profit"
          value={money(metrics.grossProfit)}
          hint={`${money(metrics.feesPaid)} fees, ${money(metrics.slippagePaid)} slippage`}
        />
        <Stat label="Max drawdown" value={pct(metrics.maxDrawdownPct)} />
        <Stat
          label="Trades"
          value={String(metrics.tradeCount)}
          hint={`${String(metrics.winCount)}W / ${String(metrics.lossCount)}L / ${String(metrics.scratchCount)} flat`}
        />
        <Stat label="Win rate" value={pct(metrics.winRatePct)} />
        <Stat
          label="Profit factor"
          value={orDash(metrics.profitFactor, (v) => Number(v).toFixed(2))}
        />
        <Stat label="Expectancy" value={money(metrics.expectancy)} hint="per trade" />
        <Stat
          label="Sharpe"
          value={orDash(metrics.sharpe, (v) => Number(v).toFixed(2))}
          hint={metrics.caveats.ratiosSuppressed ? 'too few observations' : 'annualised'}
        />
        <Stat label="Sortino" value={orDash(metrics.sortino, (v) => Number(v).toFixed(2))} />
        <Stat label="CAGR" value={orDash(metrics.cagrPct, pct)} hint="null under a month" />
        <Stat label="Exposure" value={pct(metrics.exposurePct)} hint="bars with capital at risk" />
      </CardContent>
    </Card>
  );
}

function Caveats({ metrics }: { metrics: BacktestMetrics }) {
  const { caveats } = metrics;
  const items = [
    caveats.ambiguousExits > 0 &&
      `${String(caveats.ambiguousExits)} exits fell on a bar that contained both the stop and the target. A bar is a summary, not a path, so those were resolved as stops — the pessimistic reading.`,
    caveats.gapThroughStop > 0 &&
      `${String(caveats.gapThroughStop)} stops were reached by a bar that had already gapped past them, and filled at the open instead.`,
    caveats.unknownVerdicts > 0 &&
      `${String(caveats.unknownVerdicts)} bars could not be judged because an indicator had no value. They produced no trade, and are not counted as the rule saying no.`,
    caveats.signalsNotTaken > 0 &&
      `${String(caveats.signalsNotTaken)} entry signals were not acted on — no capital, or the concurrent-position limit.`,
    caveats.openAtEnd > 0 &&
      `${String(caveats.openAtEnd)} positions were still open at the end of the window and were closed at the last price.`,
    caveats.ratiosSuppressed &&
      'Sharpe and Sortino are withheld: fewer than thirty return observations, which is too few for either to mean anything.',
    caveats.ratiosInflatedByLowExposure &&
      `Capital was at risk in only ${Number(metrics.exposurePct).toFixed(1)}% of bars. Annualising bar returns assumes the strategy was in the market, so the Sharpe and Sortino figures above are inflated well beyond anything a person would experience.`,
  ].filter((item): item is string => Boolean(item));

  return (
    <Card>
      <CardHeader className="flex-row items-center gap-2">
        <TriangleAlert className="h-3.5 w-3.5 text-amber-400" aria-hidden />
        <CardTitle>What qualifies this result</CardTitle>
      </CardHeader>
      <CardContent>
        {items.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No ambiguous exits, no gaps through a stop, nothing unjudged, nothing left open. The
            result rests on the modelling assumptions below and nothing else.
          </p>
        ) : (
          <ul className="space-y-1.5 text-xs text-muted-foreground">
            {items.map((item) => (
              <li key={item} className="flex gap-2">
                <span className="text-amber-400">·</span>
                {item}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function WalkForwardPanel({ result }: { result: WalkForwardResult }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Walk-forward</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">{result.verdict}</p>

        {result.folds.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-wider text-muted-foreground">
                  <th className="py-1 pr-3">Fold</th>
                  <th className="py-1 pr-3">In sample</th>
                  <th className="py-1 pr-3">Out of sample</th>
                  <th className="py-1 pr-3">In return</th>
                  <th className="py-1 pr-3">Out return</th>
                  <th className="py-1 pr-3">Degradation</th>
                </tr>
              </thead>
              <tbody className="tabular-nums">
                {result.folds.map((fold) => (
                  <tr key={fold.index} className="border-t border-border">
                    <td className="py-1 pr-3">{fold.index}</td>
                    <td className="py-1 pr-3 text-muted-foreground">
                      {fold.inSampleTrades} trades
                    </td>
                    <td className="py-1 pr-3 text-muted-foreground">
                      {fold.outOfSampleTrades} trades
                    </td>
                    <td className="py-1 pr-3">{pct(fold.inSampleReturnPct)}</td>
                    <td
                      className={cn(
                        'py-1 pr-3',
                        Number(fold.outOfSampleReturnPct) < 0 ? 'text-red-400' : 'text-emerald-400',
                      )}
                    >
                      {pct(fold.outOfSampleReturnPct)}
                    </td>
                    <td className="py-1 pr-3 text-muted-foreground">
                      {fold.degradationPct === null
                        ? 'not comparable'
                        : `${Number(fold.degradationPct).toFixed(2)} pts`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function MonteCarloPanel({ result }: { result: MonteCarloResult }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Monte Carlo</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">{result.verdict}</p>

        {result.iterations > 0 && (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="5th percentile" value={money(result.equityPercentiles.p5)} />
            <Stat label="Median" value={money(result.equityPercentiles.p50)} />
            <Stat label="95th percentile" value={money(result.equityPercentiles.p95)} />
            <Stat
              label="Drawdown, 95th"
              value={pct(result.drawdownPercentiles.p95)}
              hint={`worst seen ${pct(result.worstDrawdownPct)}`}
            />
          </div>
        )}
        <p className="text-[11px] text-muted-foreground">
          This resamples the trades the strategy actually took, so it is a statement about the order
          they arrived in — not a forecast. Its use is to show how much of the equity curve was a
          lucky sequence.
        </p>
      </CardContent>
    </Card>
  );
}

function Assumptions({ detail }: { detail: BacktestSummary }) {
  return (
    <Card>
      <CardHeader className="flex-row items-center gap-2">
        <AlertTriangle className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
        <CardTitle>How this was modelled</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <ul className="space-y-1 text-xs text-muted-foreground">
          {detail.parameters.assumptions.map((assumption) => (
            <li key={assumption}>· {assumption}</li>
          ))}
        </ul>
        {detail.parameters.windowUsed && (
          <p className="text-[11px] text-muted-foreground">
            Bars actually read span {formatDateTime(detail.parameters.windowUsed.from)} to{' '}
            {formatDateTime(detail.parameters.windowUsed.to)} — which is the window this result
            describes, whatever was requested.
          </p>
        )}
        <p className="text-[11px] text-muted-foreground">
          Universe: {detail.parameters.universe.join(', ') || 'none'} ·{' '}
          {detail.parameters.barsLoaded} bars loaded · commission{' '}
          {detail.parameters.costs.commissionPerTrade}, half-spread{' '}
          {detail.parameters.costs.spreadFraction}, slippage{' '}
          {detail.parameters.costs.slippageFraction}
        </p>
      </CardContent>
    </Card>
  );
}

function Trades({ detail }: { detail: BacktestDetail }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{detail.trades.length} trades</CardTitle>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-[10px] uppercase tracking-wider text-muted-foreground">
              <th className="py-1 pr-3">Symbol</th>
              <th className="py-1 pr-3">Entry</th>
              <th className="py-1 pr-3">Exit</th>
              <th className="py-1 pr-3">Qty</th>
              <th className="py-1 pr-3">Reason</th>
              <th className="py-1 pr-3">Net</th>
              <th className="py-1 pr-3">R</th>
            </tr>
          </thead>
          <tbody className="tabular-nums">
            {detail.trades.map((trade, index) => (
              <tr
                key={`${trade.symbol}-${trade.entryTime}-${String(index)}`}
                className="border-t border-border"
              >
                <td className="py-1 pr-3">{trade.symbol}</td>
                <td className="py-1 pr-3 text-muted-foreground">
                  {formatDateTime(trade.entryTime)} @ {Number(trade.entryPrice).toFixed(2)}
                </td>
                <td className="py-1 pr-3 text-muted-foreground">
                  {trade.exitTime ? formatDateTime(trade.exitTime) : '—'} @{' '}
                  {trade.exitPrice ? Number(trade.exitPrice).toFixed(2) : '—'}
                </td>
                <td className="py-1 pr-3">{trade.quantity}</td>
                <td className="py-1 pr-3 text-muted-foreground">{trade.exitReason ?? '—'}</td>
                <td
                  className={cn(
                    'py-1 pr-3',
                    Number(trade.netPnl ?? 0) < 0 ? 'text-red-400' : 'text-emerald-400',
                  )}
                >
                  {trade.netPnl ? money(trade.netPnl) : '—'}
                </td>
                <td className="py-1 pr-3 text-muted-foreground">
                  {trade.rMultiple ? Number(trade.rMultiple).toFixed(2) : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}

/** Thirty days back, which is the window the demo backfill can actually fill. */
function defaultFrom(): string {
  const date = new Date(Date.now() - 30 * 86_400_000);
  return date.toISOString().slice(0, 10);
}

function defaultTo(): string {
  return new Date().toISOString().slice(0, 10);
}
