import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BookOpen, CameraIcon, Wallet } from 'lucide-react';
import { useState } from 'react';
import { EquityCurve } from '@/components/backtest/EquityCurve';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { useAuth } from '@/hooks/useAuth';
import { useSelectedPortfolio } from '@/hooks/useSelectedPortfolio';
import { usePortfolios } from '@/hooks/usePortfolios';
import { api, explainApiError } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import type { JournalEntry, PerformanceReport } from '@/lib/types';

/**
 * Performance and the trade journal.
 *
 * Both return measures are always on screen together. The time-weighted figure
 * answers "how did the strategy do" and the money-weighted one answers "how did
 * this investor do"; they differ, sometimes by a lot, and showing only the
 * flattering one is the oldest trick in this business.
 *
 * A deposit is reported as a deposit. An account that grew because somebody
 * wired money in has returned nothing, and the page says so in the same row.
 */
export function PerformancePage() {
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const canWrite = can('portfolio:write');

  const [from, setFrom] = useState(defaultFrom());
  const [to, setTo] = useState(today());
  const [amount, setAmount] = useState('');
  const [flowType, setFlowType] = useState<'DEPOSIT' | 'WITHDRAWAL'>('DEPOSIT');
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  // Scoped to the owner chosen on the dashboard. A selector that offered
  // every book while a person was thinking about one relative's is a way to
  // commit the wrong one, and this is a page where that costs money.
  const { portfolios } = usePortfolios();

  const { selectedId: id, select: setPortfolioId } = useSelectedPortfolio(portfolios);

  const { data: report } = useQuery({
    queryKey: ['performance', id, from, to],
    queryFn: () =>
      api<PerformanceReport>(
        `/api/performance/report?portfolioId=${id}` +
          `&from=${new Date(`${from}T00:00:00.000Z`).toISOString()}` +
          `&to=${new Date(`${to}T23:59:59.000Z`).toISOString()}`,
      ),
    enabled: Boolean(id),
  });

  const { data: journal } = useQuery({
    queryKey: ['journal', id],
    queryFn: () => api<{ entries: JournalEntry[] }>(`/api/performance/journal?portfolioId=${id}`),
    enabled: Boolean(id),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['performance'] });
    void queryClient.invalidateQueries({ queryKey: ['journal'] });
    void queryClient.invalidateQueries({ queryKey: ['portfolios'] });
  };

  const snapshot = useMutation({
    mutationFn: () =>
      api<unknown>('/api/performance/snapshots', {
        method: 'POST',
        body: { portfolioId: id },
      }),
    onSuccess: () => {
      setError(null);
      invalidate();
    },
    onError: (err: Error) => setError(explainApiError(err)),
  });

  const cashFlow = useMutation({
    mutationFn: () =>
      api<unknown>('/api/performance/cash-flows', {
        method: 'POST',
        body: { portfolioId: id, type: flowType, amount },
      }),
    onSuccess: () => {
      setAmount('');
      setError(null);
      invalidate();
    },
    onError: (err: Error) => setError(explainApiError(err)),
  });

  const appendNote = useMutation({
    mutationFn: ({ entryId, note }: { entryId: string; note: string }) =>
      api<JournalEntry>(`/api/performance/journal/${entryId}/notes`, {
        method: 'POST',
        body: { note },
      }),
    onSuccess: (_data, variables) => {
      setNotes({ ...notes, [variables.entryId]: '' });
      setError(null);
      invalidate();
    },
    onError: (err: Error) => setError(explainApiError(err)),
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

        <Input
          type="date"
          className="h-8 w-36 text-xs"
          aria-label="From"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
        />
        <Input
          type="date"
          className="h-8 w-36 text-xs"
          aria-label="To"
          value={to}
          onChange={(e) => setTo(e.target.value)}
        />

        {canWrite && (
          <Button
            variant="ghost"
            size="sm"
            className="text-xs"
            disabled={snapshot.isPending}
            onClick={() => snapshot.mutate()}
          >
            <CameraIcon className="mr-1 h-3.5 w-3.5" aria-hidden />
            Snapshot now
          </Button>
        )}
      </div>

      {error && (
        <p className="rounded-md border border-red-500/30 bg-red-500/5 p-2 text-xs text-red-400">
          {error}
        </p>
      )}

      {report && (
        <>
          <Card>
            <CardHeader>
              <CardTitle>
                {formatDateTime(report.from)} → {formatDateTime(report.to)}
              </CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat
                label="Time-weighted"
                value={orDash(report.timeWeightedReturnPct)}
                hint="how the strategy did"
              />
              <Stat
                label="Money-weighted"
                value={orDash(report.moneyWeightedReturnPct)}
                hint="how this investor did"
              />
              <Stat
                label="Investment gain"
                value={money(report.investmentGain)}
                hint="equity change minus deposits"
              />
              <Stat
                label="Net deposits"
                value={money(report.netDeposits)}
                hint="never counted as profit"
              />
              <Stat label="Opening equity" value={money(report.openingEquity)} />
              <Stat label="Closing equity" value={money(report.closingEquity)} />
              <Stat label="Realised" value={money(report.realizedPnl)} />
              <Stat
                label="Unrealised"
                value={money(report.unrealizedPnl)}
                hint="marked, not banked"
              />
              <Stat label="Fees paid" value={money(report.feesPaid)} />
              <Stat label="Max drawdown" value={`${Number(report.maxDrawdownPct).toFixed(2)}%`} />
              <Stat label="Snapshots" value={String(report.snapshots.length)} />
            </CardContent>
          </Card>

          {report.snapshots.length > 1 && (
            <EquityCurve
              points={report.snapshots.map((row) => ({ at: row.asOf, equity: row.equity }))}
              initialCapital={report.openingEquity}
              timeframe="1d"
            />
          )}

          <Card>
            <CardHeader>
              <CardTitle>How these figures were produced</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="space-y-1 text-xs text-muted-foreground">
                {report.notes.map((note) => (
                  <li key={note}>· {note}</li>
                ))}
              </ul>
            </CardContent>
          </Card>
        </>
      )}

      {canWrite && (
        <Card>
          <CardHeader className="flex-row items-center gap-2">
            <Wallet className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
            <CardTitle>Record a deposit or withdrawal</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap items-center gap-2">
            <select
              className="rounded-md border border-input bg-background px-2 py-1 text-xs"
              aria-label="Cash flow type"
              value={flowType}
              onChange={(e) => setFlowType(e.target.value as 'DEPOSIT' | 'WITHDRAWAL')}
            >
              <option value="DEPOSIT">deposit</option>
              <option value="WITHDRAWAL">withdrawal</option>
            </select>
            <Input
              className="h-8 w-32 text-xs tabular-nums"
              aria-label="Amount"
              inputMode="decimal"
              placeholder="amount"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
            <Button
              size="sm"
              disabled={cashFlow.isPending || !amount.trim()}
              onClick={() => cashFlow.mutate()}
            >
              Record
            </Button>
            <p className="text-[11px] text-muted-foreground">
              Kept as its own row and removed from both return measures.
            </p>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="flex-row items-center gap-2">
          <BookOpen className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
          <CardTitle>Trade journal</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {(journal?.entries ?? []).length === 0 && (
            <p className="text-xs text-muted-foreground">
              No entries yet. One is written automatically when a position opens, with the context
              that opened it.
            </p>
          )}

          {(journal?.entries ?? []).map((entry) => (
            <div key={entry.id} className="rounded-md border border-border p-2 text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{entry.symbol ?? '—'}</span>
                <span className="text-[11px] text-muted-foreground">
                  {formatDateTime(entry.createdAt)}
                </span>
              </div>
              {entry.entryThesis && <p className="mt-1">{entry.entryThesis}</p>}
              {entry.userNotes && (
                <pre className="mt-1 whitespace-pre-wrap text-[11px] text-muted-foreground">
                  {entry.userNotes}
                </pre>
              )}
              {entry.outcome && (
                <p className="mt-1 text-[11px] text-emerald-400">outcome: {entry.outcome}</p>
              )}

              {canWrite && (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <Input
                    className="h-8 min-w-40 flex-1 text-xs"
                    aria-label={`Note for ${entry.symbol ?? 'entry'}`}
                    placeholder="Append a note"
                    value={notes[entry.id] ?? ''}
                    onChange={(e) => setNotes({ ...notes, [entry.id]: e.target.value })}
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={appendNote.isPending || (notes[entry.id] ?? '').trim().length < 2}
                    onClick={() =>
                      appendNote.mutate({ entryId: entry.id, note: notes[entry.id] ?? '' })
                    }
                  >
                    Append
                  </Button>
                </div>
              )}
            </div>
          ))}
          <p className="text-[10px] text-muted-foreground">
            Notes are appended, never replacing what was written at entry. A thesis edited after the
            outcome is known stops being evidence.
          </p>
        </CardContent>
      </Card>
    </main>
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

/** A withheld figure reads as withheld, never as zero. */
function orDash(value: string | null): string {
  return value === null ? '—' : `${Number(value).toFixed(2)}%`;
}

const money = (value: string) =>
  Number(value).toLocaleString(undefined, { maximumFractionDigits: 2 });

function defaultFrom(): string {
  return new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}
