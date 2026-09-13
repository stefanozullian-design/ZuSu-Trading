import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Calculator, Scale, ShieldAlert } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { useSelectedPortfolio } from '@/hooks/useSelectedPortfolio';
import { usePortfolios } from '@/hooks/usePortfolios';
import { api, explainApiError } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { ReconciliationRun, RiskAssessment, RiskEventRow, RiskLimits } from '@/lib/types';

/**
 * Risk.
 *
 * Two things on one page: what the limits are, and what a proposed trade would
 * do to them. The calculator is the useful half — it sizes a position from the
 * distance to its stop and then checks the whole book, and every check shows
 * its limit next to the actual value, because a refusal that says only "risk
 * limit exceeded" cannot be acted on.
 *
 * Nothing here places anything. Assessing is a read.
 */
export function RiskPage() {
  const [symbol, setSymbol] = useState('AAPL');
  const [entryPrice, setEntryPrice] = useState('100');
  const [stopPrice, setStopPrice] = useState('98');
  const [riskPct, setRiskPct] = useState('1');
  const [assessment, setAssessment] = useState<RiskAssessment | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Scoped to the owner chosen on the dashboard. A selector that offered
  // every book while a person was thinking about one relative's is a way to
  // commit the wrong one, and this is a page where that costs money.
  const { portfolios } = usePortfolios();

  const { selectedId: id, select: setPortfolioId } = useSelectedPortfolio(portfolios);

  const { data: limits } = useQuery({
    queryKey: ['risk-limits', id],
    queryFn: () => api<RiskLimits>(`/api/risk/portfolios/${id}/limits`),
    enabled: Boolean(id),
  });

  const { data: events } = useQuery({
    queryKey: ['risk-events', id],
    queryFn: () => api<{ events: RiskEventRow[] }>(`/api/risk/portfolios/${id}/events`),
    enabled: Boolean(id),
    refetchInterval: 30_000,
  });

  const assess = useMutation({
    mutationFn: () =>
      api<RiskAssessment>(`/api/risk/portfolios/${id}/assess`, {
        method: 'POST',
        body: {
          symbol,
          direction: 'LONG',
          entryPrice,
          stopPrice: stopPrice || null,
          riskPerTradePct: riskPct,
        },
      }),
    onSuccess: (data) => {
      setAssessment(data);
      setError(null);
    },
    onError: (err: Error) => {
      setAssessment(null);
      setError(explainApiError(err));
    },
  });

  return (
    <main className="mx-auto w-full max-w-7xl space-y-3 px-3 py-4 sm:px-6">
      <div className="flex flex-wrap items-center gap-2">
        <select
          className="rounded-md border border-input bg-background px-2 py-1 text-xs"
          aria-label="Portfolio"
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

      <div className="grid gap-3 lg:grid-cols-[320px_minmax(0,1fr)]">
        <div className="space-y-3">
          <Card>
            <CardHeader className="flex-row items-center gap-2">
              <Calculator className="h-3.5 w-3.5 text-sky-400" aria-hidden />
              <CardTitle>Size a trade</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <Field label="Symbol">
                <Input
                  className="h-8 text-xs"
                  aria-label="Symbol"
                  value={symbol}
                  onChange={(e) => setSymbol(e.target.value.toUpperCase())}
                />
              </Field>
              <div className="flex gap-2">
                <Field label="Entry">
                  <Input
                    className="h-8 text-xs tabular-nums"
                    aria-label="Entry price"
                    inputMode="decimal"
                    value={entryPrice}
                    onChange={(e) => setEntryPrice(e.target.value)}
                  />
                </Field>
                <Field label="Stop">
                  <Input
                    className="h-8 text-xs tabular-nums"
                    aria-label="Stop price"
                    inputMode="decimal"
                    value={stopPrice}
                    onChange={(e) => setStopPrice(e.target.value)}
                  />
                </Field>
              </div>
              <Field label="Risk per trade (% of equity)">
                <Input
                  className="h-8 text-xs tabular-nums"
                  aria-label="Risk per trade"
                  inputMode="decimal"
                  value={riskPct}
                  onChange={(e) => setRiskPct(e.target.value)}
                />
              </Field>

              <Button
                size="sm"
                className="w-full"
                disabled={assess.isPending || !id}
                onClick={() => assess.mutate()}
              >
                {assess.isPending ? 'Checking…' : 'Size and check'}
              </Button>
              <p className="text-[10px] text-muted-foreground">
                Sizing is measured in the distance to the stop, so a wider stop buys fewer shares
                and the loss if the stop is hit is the same fraction either way. Without a stop it
                refuses rather than falling back to a notional cap.
              </p>
            </CardContent>
          </Card>

          {limits && (
            <Card>
              <CardHeader>
                <CardTitle>Limits, version {limits.version}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-1 text-xs">
                <Limit label="Max daily loss" value={money(limits.maxDailyLoss)} />
                <Limit label="Max weekly loss" value={money(limits.maxWeeklyLoss)} />
                <Limit label="Max position size" value={money(limits.maxPositionSize)} />
                <Limit label="Portfolio exposure" value={`${limits.maxPortfolioExposurePct}%`} />
                <Limit label="Sector exposure" value={`${limits.maxSectorExposurePct}%`} />
                <Limit label="Symbol exposure" value={`${limits.maxSymbolExposurePct}%`} />
                <Limit label="Open positions" value={String(limits.maxOpenPositions)} />
                <Limit label="Trades per day" value={String(limits.maxTradesPerDay)} />
                <Limit label="Consecutive losses" value={String(limits.maxConsecutiveLosses)} />
                <Limit label="Max drawdown" value={`${limits.maxDrawdownPct}%`} />
              </CardContent>
            </Card>
          )}

          <ReconciliationPanel portfolioId={id} />
        </div>

        <div className="space-y-3">
          {assessment && (
            <>
              <Card>
                <CardHeader className="flex-row items-center justify-between gap-2">
                  <CardTitle>
                    {assessment.allowed ? 'Would be allowed' : 'Would be refused'}
                  </CardTitle>
                  <Badge
                    className={cn(
                      assessment.allowed
                        ? 'border-emerald-500/40 text-emerald-400'
                        : 'border-red-500/40 text-red-400',
                    )}
                  >
                    {assessment.allowed ? 'PASS' : 'BLOCKED'}
                  </Badge>
                </CardHeader>
                <CardContent className="space-y-3">
                  {assessment.sizing && (
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                      <Stat label="Shares" value={assessment.sizing.quantity} />
                      <Stat
                        label="Risk if stopped"
                        value={money(assessment.sizing.riskAmount)}
                        hint={
                          assessment.sizing.riskPerShare
                            ? `${Number(assessment.sizing.riskPerShare).toFixed(4)} per share`
                            : undefined
                        }
                      />
                      <Stat label="Notional" value={money(assessment.sizing.notional)} />
                      <Stat
                        label="Bound by"
                        value={assessment.sizing.boundBy}
                        hint={
                          assessment.sizing.volatilityFloorApplied
                            ? 'stop widened to the volatility floor'
                            : undefined
                        }
                      />
                    </div>
                  )}
                  {assessment.sizing?.reason && (
                    <p className="rounded-md border border-amber-500/30 bg-amber-500/5 p-2 text-xs text-amber-300">
                      {assessment.sizing.reason}
                    </p>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Every check, with its numbers</CardTitle>
                </CardHeader>
                <CardContent className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-left text-[10px] uppercase tracking-wider text-muted-foreground">
                        <th className="py-1 pr-3">Limit</th>
                        <th className="py-1 pr-3">Actual</th>
                        <th className="py-1 pr-3">Limit value</th>
                        <th className="py-1 pr-3">Verdict</th>
                      </tr>
                    </thead>
                    <tbody className="tabular-nums">
                      {assessment.checks.map((check) => (
                        <tr key={check.limitName} className="border-t border-border align-top">
                          <td className="py-1 pr-3">{check.limitName}</td>
                          <td className="py-1 pr-3">
                            {check.actual === null ? (
                              <span className="text-amber-400">— not measurable</span>
                            ) : (
                              Number(check.actual).toFixed(2)
                            )}
                          </td>
                          <td className="py-1 pr-3 text-muted-foreground">
                            {Number(check.limit).toFixed(2)}
                          </td>
                          <td
                            className={cn(
                              'py-1 pr-3',
                              check.passed ? 'text-muted-foreground' : 'text-red-400',
                            )}
                          >
                            {check.passed ? 'ok' : 'breach'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <ul className="mt-2 space-y-1 text-[11px] text-muted-foreground">
                    {assessment.checks
                      .filter((check) => !check.passed || check.actual === null)
                      .map((check) => (
                        <li key={`${check.limitName}-message`}>· {check.message}</li>
                      ))}
                  </ul>
                </CardContent>
              </Card>
            </>
          )}

          <Card>
            <CardHeader className="flex-row items-center gap-2">
              <ShieldAlert className="h-3.5 w-3.5 text-amber-400" aria-hidden />
              <CardTitle>Recent risk events</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1.5">
              {(events?.events ?? []).length === 0 && (
                <p className="text-xs text-muted-foreground">
                  Nothing recorded. Breaches and near-misses both land here — a pattern of
                  near-misses is what makes the eventual breach unsurprising.
                </p>
              )}
              {(events?.events ?? []).map((event) => (
                <div key={event.id} className="rounded-md border border-border p-2 text-xs">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge
                      className={cn(
                        event.severity === 'CRITICAL' && 'border-red-500/40 text-red-400',
                        event.severity === 'WARNING' && 'border-amber-500/40 text-amber-400',
                      )}
                    >
                      {event.type}
                    </Badge>
                    <span className="text-[11px] text-muted-foreground">
                      {formatDateTime(event.createdAt)}
                    </span>
                  </div>
                  <p className="mt-1">{event.message}</p>
                  {event.limitName && (
                    <p className="text-[11px] tabular-nums text-muted-foreground">
                      {event.limitName}: {event.actualValue} against {event.limitValue}
                    </p>
                  )}
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      </div>
    </main>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="block text-[10px] uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      {children}
    </label>
  );
}

function Limit({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
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

const money = (value: string) =>
  Number(value).toLocaleString(undefined, { maximumFractionDigits: 2 });

/**
 * Reconciliation.
 *
 * Two records of the same account, compared. The rule that makes it worth
 * running is that it corrects nothing: a difference is reported and both sides
 * are left as they are, because a reconciler that silently picks a winner
 * destroys the only evidence that they ever disagreed.
 */
function ReconciliationPanel({ portfolioId }: { portfolioId: string }) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const { data: runs } = useQuery({
    queryKey: ['reconciliations', portfolioId],
    queryFn: () => api<ReconciliationRun[]>(`/api/broker/${portfolioId}/reconciliations`),
    enabled: Boolean(portfolioId),
  });

  const run = useMutation({
    mutationFn: () =>
      api<ReconciliationRun>(`/api/broker/${portfolioId}/reconcile`, { method: 'POST' }),
    onSuccess: async () => {
      setError(null);
      await queryClient.invalidateQueries({ queryKey: ['reconciliations', portfolioId] });
    },
    onError: (err: Error) => setError(explainApiError(err)),
  });

  const latest = run.data ?? runs?.[0] ?? null;

  return (
    <Card>
      <CardHeader className="flex-row items-center gap-2">
        <Scale className="h-3.5 w-3.5 text-sky-400" aria-hidden />
        <CardTitle>Reconciliation</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-xs">
        <Button
          size="sm"
          variant="outline"
          className="w-full"
          disabled={run.isPending || !portfolioId}
          onClick={() => run.mutate()}
        >
          {run.isPending ? 'Comparing…' : 'Compare against the broker'}
        </Button>

        {error && <p className="text-[11px] text-red-400">{error}</p>}

        {!latest && !error && (
          <p className="text-[11px] text-muted-foreground">
            Never run for this portfolio. It reads both records and reports what differs; it never
            writes a correction.
          </p>
        )}

        {latest && (
          <>
            <div className="flex items-center gap-2">
              <Badge
                className={cn(
                  latest.succeeded
                    ? 'border-emerald-500/40 text-emerald-400'
                    : latest.positionMismatch
                      ? 'border-red-500/40 text-red-400'
                      : 'border-amber-500/40 text-amber-400',
                )}
              >
                {latest.succeeded ? 'AGREES' : 'DIFFERS'}
              </Badge>
              <span className="text-[11px] text-muted-foreground">{latest.detail}</span>
            </div>

            {latest.differences.map((difference, index) => (
              <div
                key={`${difference.kind}-${difference.symbol ?? 'account'}-${String(index)}`}
                className="rounded-md border border-border p-2"
              >
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    {difference.kind.replaceAll('_', ' ').toLowerCase()}
                  </span>
                  {difference.symbol && <span className="font-medium">{difference.symbol}</span>}
                </div>
                <p className="tabular-nums text-[11px]">
                  here {difference.ours ?? '—'} · broker {difference.theirs ?? '—'}
                </p>
                <p className="text-[11px] text-muted-foreground">{difference.detail}</p>
              </div>
            ))}
          </>
        )}
      </CardContent>
    </Card>
  );
}
