import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleHelp, Play, Star, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { ConditionBuilder } from '@/components/market/ConditionBuilder';
import { ScanComparison } from '@/components/market/ScanComparison';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { useAuth } from '@/hooks/useAuth';
import { usePortfolios } from '@/hooks/usePortfolios';
import { api, explainApiError as explain } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { ScanCondition, ScanRunResult, SavedScan, Watchlist } from '@/lib/types';

const TIMEFRAMES = ['5m', '1d'] as const;

/**
 * The scanner.
 *
 * The design point worth noting is the "could not evaluate" panel. A scanner
 * that silently omits symbols whose indicators have not warmed up looks like
 * it found nothing, when in fact it never asked the question. Those symbols
 * are listed with the field that was missing, so an empty result set can be
 * told apart from an unanswerable one.
 */
export function ScannerPage() {
  const { can } = useAuth();
  const { portfolios } = usePortfolios();
  const queryClient = useQueryClient();
  const canWrite = can('watchlist:write');

  const [timeframe, setTimeframe] = useState<(typeof TIMEFRAMES)[number]>('5m');
  const [watchlistId, setWatchlistId] = useState<string>('');
  const [conditions, setConditions] = useState<ScanCondition[]>([
    { field: 'rsi14', operator: 'lt', operand: { constant: '35' } },
    { field: 'close', operator: 'gt', operand: { field: 'sma50' } },
  ]);
  const [result, setResult] = useState<ScanRunResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saveName, setSaveName] = useState('');

  const { data: watchlists } = useQuery({
    queryKey: ['watchlists'],
    queryFn: () => api<{ watchlists: Watchlist[] }>('/api/market-data/watchlists'),
  });

  const { data: scans } = useQuery({
    queryKey: ['scans'],
    queryFn: () => api<{ scans: SavedScan[] }>('/api/market-data/scans'),
  });

  const run = useMutation({
    mutationFn: () =>
      api<ScanRunResult>('/api/market-data/scans/run', {
        method: 'POST',
        body: {
          timeframe,
          conditions,
          watchlistId: watchlistId || null,
          barLimit: 200,
        },
      }),
    onSuccess: (data) => {
      setResult(data);
      setError(null);
    },
    onError: (err: Error) => {
      setError(explain(err));
      setResult(null);
    },
  });

  const runSaved = useMutation({
    mutationFn: (scan: SavedScan) =>
      api<ScanRunResult>(`/api/market-data/scans/${scan.id}/run`, {
        method: 'POST',
        body: { barLimit: 200 },
      }),
    onSuccess: (data, scan) => {
      setResult(data);
      setError(null);
      setConditions(scan.conditions);
      setTimeframe(scan.timeframe as (typeof TIMEFRAMES)[number]);
      setWatchlistId(scan.watchlistId ?? '');
      void queryClient.invalidateQueries({ queryKey: ['scans'] });
    },
    onError: (err: Error) => setError(explain(err)),
  });

  const save = useMutation({
    mutationFn: () =>
      api<SavedScan>('/api/market-data/scans', {
        method: 'POST',
        body: {
          name: saveName,
          timeframe,
          conditions,
          watchlistId: watchlistId || null,
        },
      }),
    onSuccess: () => {
      setSaveName('');
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ['scans'] });
    },
    onError: (err: Error) => setError(explain(err)),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api<null>(`/api/market-data/scans/${id}`, { method: 'DELETE' }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['scans'] }),
  });

  const valueColumns = result
    ? [...new Set(result.matches.flatMap((m) => Object.keys(m.values)))].sort()
    : [];

  return (
    <main className="mx-auto w-full max-w-7xl space-y-3 px-3 py-4 sm:px-6">
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_260px]">
        <div className="space-y-3">
          <Card>
            <CardHeader className="flex-row items-center justify-between gap-2">
              <CardTitle>Filter</CardTitle>
              <div className="flex items-center gap-1">
                {TIMEFRAMES.map((tf) => (
                  <button
                    key={tf}
                    type="button"
                    onClick={() => setTimeframe(tf)}
                    className={cn(
                      'rounded-md px-2 py-0.5 text-xs transition-colors',
                      tf === timeframe
                        ? 'bg-muted text-foreground'
                        : 'text-muted-foreground hover:bg-muted/60',
                    )}
                    aria-current={tf === timeframe}
                  >
                    {tf}
                  </button>
                ))}
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <ConditionBuilder conditions={conditions} onChange={setConditions} />

              <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
                <label className="text-xs text-muted-foreground" htmlFor="scan-universe">
                  Universe
                </label>
                <select
                  id="scan-universe"
                  className="rounded-md border border-input bg-background px-2 py-1 text-xs"
                  value={watchlistId}
                  onChange={(e) => setWatchlistId(e.target.value)}
                >
                  <option value="">Every instrument</option>
                  {(watchlists?.watchlists ?? []).map((watchlist) => (
                    <option key={watchlist.id} value={watchlist.id}>
                      {watchlist.name} ({watchlist.symbols.length})
                    </option>
                  ))}
                </select>

                <Button
                  size="sm"
                  onClick={() => run.mutate()}
                  disabled={run.isPending}
                  className="ml-auto"
                >
                  <Play className="mr-1 h-3.5 w-3.5" aria-hidden />
                  {run.isPending ? 'Running…' : 'Run scan'}
                </Button>
              </div>

              {canWrite && (
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    className="h-8 max-w-52 text-xs"
                    // A placeholder is not a label: it disappears the moment
                    // anyone types, and a screen reader gets nothing.
                    aria-label="Save this filter as"
                    placeholder="Save this filter as…"
                    value={saveName}
                    onChange={(e) => setSaveName(e.target.value)}
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={!saveName.trim() || save.isPending}
                    onClick={() => save.mutate()}
                  >
                    <Star className="mr-1 h-3.5 w-3.5" aria-hidden />
                    Save
                  </Button>
                </div>
              )}

              {error && (
                <p className="rounded-md border border-red-500/30 bg-red-500/5 p-2 text-xs text-red-400">
                  {error}
                </p>
              )}
            </CardContent>
          </Card>

          {result && (
            <>
              <Card role="region" aria-label="Scan result">
                <CardHeader className="flex-row items-baseline justify-between gap-2">
                  <CardTitle>
                    {result.matches.length} match{result.matches.length === 1 ? '' : 'es'}
                  </CardTitle>
                  <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    {result.evaluated} of {result.universe.length} evaluated ·{' '}
                    {formatDateTime(result.ranAt)}
                  </span>
                </CardHeader>
                <CardContent>
                  <p className="mb-2 text-xs text-muted-foreground">
                    {result.summary.length === 0
                      ? 'No conditions — every symbol with enough data.'
                      : result.summary.join(' · and · ')}
                  </p>

                  {result.matches.length === 0 ? (
                    <p className="py-4 text-center text-sm text-muted-foreground">
                      Nothing matched.
                      {result.notEvaluable.length > 0 &&
                        ` ${String(result.notEvaluable.length)} symbol(s) could not be evaluated — see below.`}
                    </p>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-left text-xs">
                        <thead className="text-[10px] uppercase tracking-wider text-muted-foreground">
                          <tr>
                            <th className="pb-1 pr-3 font-medium">Symbol</th>
                            {valueColumns.map((column) => (
                              <th key={column} className="pb-1 pr-3 text-right font-medium">
                                {column}
                              </th>
                            ))}
                            <th className="pb-1 text-right font-medium">As of</th>
                          </tr>
                        </thead>
                        <tbody>
                          {result.matches.map((match) => (
                            <tr key={match.symbol} className="border-t border-border/60">
                              <td className="py-1 pr-3 font-medium">{match.symbol}</td>
                              {valueColumns.map((column) => (
                                <td
                                  key={column}
                                  className="py-1 pr-3 text-right font-mono tabular-nums"
                                >
                                  {formatValue(match.values[column])}
                                </td>
                              ))}
                              <td className="py-1 text-right tabular-nums text-muted-foreground">
                                {formatDateTime(match.asOf)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* The panel that makes an empty result honest. */}
              {result.notEvaluable.length > 0 && (
                <Card className="border-dashed">
                  <CardHeader className="flex-row items-center justify-between gap-2">
                    <CardTitle>Could not evaluate</CardTitle>
                    <Badge variant="neutral">{result.notEvaluable.length}</Badge>
                  </CardHeader>
                  <CardContent>
                    <div className="mb-2 flex items-start gap-2 text-xs text-muted-foreground">
                      <CircleHelp className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                      <p>
                        These symbols were not a non-match — the question could not be asked of
                        them. An indicator still in warm-up has no value, so it cannot satisfy or
                        fail a condition.
                      </p>
                    </div>
                    <table className="w-full text-left text-xs">
                      <tbody>
                        {result.notEvaluable.map((skip) => (
                          <tr key={skip.symbol} className="border-t border-border/60">
                            <td className="py-1 pr-3 font-medium">{skip.symbol}</td>
                            <td className="py-1 pr-3 text-muted-foreground">
                              {skip.missingField ?? '—'}
                            </td>
                            <td className="py-1 text-muted-foreground">{skip.reason}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </CardContent>
                </Card>
              )}
            </>
          )}
        </div>

        <div className="space-y-3">
          <Card role="region" aria-label="Saved scans">
            <CardHeader>
              <CardTitle>Saved scans</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1.5">
              {(scans?.scans ?? []).length === 0 && (
                <p className="text-xs text-muted-foreground">
                  None saved yet. Build a filter and give it a name.
                </p>
              )}
              {(scans?.scans ?? []).map((scan) => (
                <div key={scan.id} className="rounded-md border border-border p-2">
                  <div className="flex items-start justify-between gap-1">
                    <button
                      type="button"
                      className="text-left text-xs font-medium hover:underline"
                      onClick={() => runSaved.mutate(scan)}
                    >
                      {scan.name}
                    </button>
                    {canWrite && (
                      <button
                        type="button"
                        className="rounded p-0.5 text-muted-foreground hover:text-red-400"
                        aria-label={`Delete ${scan.name}`}
                        onClick={() => remove.mutate(scan.id)}
                      >
                        <Trash2 className="h-3 w-3" aria-hidden />
                      </button>
                    )}
                  </div>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">
                    {scan.summary.join(' · ')}
                  </p>
                  <p className="mt-0.5 text-[10px] text-muted-foreground">
                    {scan.timeframe}
                    {scan.lastRunAt
                      ? ` · last run ${formatDateTime(scan.lastRunAt)}`
                      : ' · never run'}
                  </p>
                </div>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Watchlists</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1.5">
              {(watchlists?.watchlists ?? []).length === 0 && (
                <p className="text-xs text-muted-foreground">No watchlists.</p>
              )}
              {(watchlists?.watchlists ?? []).map((watchlist) => (
                <div key={watchlist.id} className="rounded-md border border-border p-2">
                  <div className="flex items-center justify-between gap-1">
                    <span className="text-xs font-medium">{watchlist.name}</span>
                    {watchlist.isSystem && <Badge variant="neutral">system</Badge>}
                  </div>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">
                    {watchlist.symbols.length === 0 ? 'empty' : watchlist.symbols.join(', ')}
                  </p>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      </div>

      {/*
        Below the single-filter workspace, because it only becomes possible
        once there are saved filters to compare — and because the comparison
        is the reason for saving them.
      */}
      <ScanComparison scans={scans?.scans ?? []} portfolios={portfolios} />
    </main>
  );
}

function formatValue(value: string | undefined): string {
  if (value === undefined) return '—';
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return value;
  const abs = Math.abs(parsed);
  if (abs >= 1_000_000) return `${(parsed / 1_000_000).toFixed(2)}M`;
  if (abs >= 10_000) return parsed.toLocaleString(undefined, { maximumFractionDigits: 0 });
  return parsed.toFixed(abs < 1 ? 4 : 2);
}

/**
 * A message the user can act on.
 *
 * Schema validation returns a generic "did not match the expected shape" with
 * the useful part — which field, and why — in `details`. A refusal nobody can
 * act on is barely better than silence, so the detail is appended.
 */
