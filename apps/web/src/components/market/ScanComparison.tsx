import { useMutation } from '@tanstack/react-query';
import { Check, Minus } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { api, explainApiError } from '@/lib/api';
import { cn } from '@/lib/utils';
import type { ComparisonDto, PortfolioSummary, SavedScan } from '@/lib/types';

/**
 * Several saved scans, side by side.
 *
 * Every screening view here used to be organised by method: pick a filter, run
 * it, read its list. Comparing two meant running one, remembering it, running
 * the other — so the one fact worth having was the one nobody ever had.
 *
 * That fact is agreement, and this view exists to produce it. Symbols are the
 * rows, methods are the columns, and the table sorts by how many methods
 * flagged each symbol.
 *
 * The agreement column is a count and is labelled as one. It is not a score:
 * three filters that all test momentum are one opinion stated three times, and
 * nothing here can tell the difference. The caveats are printed under the
 * table rather than tucked into a tooltip, because a number in a column headed
 * with a tick is going to be read as a verdict unless something says otherwise.
 */
export function ScanComparison({
  scans,
  portfolios,
}: {
  scans: SavedScan[];
  portfolios: PortfolioSummary[] | undefined;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [portfolioId, setPortfolioId] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ComparisonDto | null>(null);

  const compare = useMutation({
    mutationFn: () =>
      api<ComparisonDto>('/api/market-data/scans/compare', {
        method: 'POST',
        body: {
          scanIds: selected,
          portfolioId: portfolioId === '' ? null : portfolioId,
          barLimit: 200,
        },
      }),
    onSuccess: (data) => {
      setError(null);
      setResult(data);
    },
    onError: (err: Error) => {
      setResult(null);
      setError(explainApiError(err));
    },
  });

  function toggle(id: string) {
    setSelected((current) =>
      current.includes(id) ? current.filter((x) => x !== id) : [...current, id],
    );
  }

  const nameOf = new Map(scans.map((scan) => [scan.id, scan.name]));

  return (
    <Card role="region" aria-label="Compare scans">
      <CardHeader>
        <CardTitle>Compare scans</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          Run several filters at once and see which symbols more than one of them picked. Reading
          the lists one at a time cannot tell you that.
        </p>

        {scans.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No saved scans yet. Build a filter above and save it, then another, and they become the
            columns here.
          </p>
        )}

        <div className="flex flex-wrap gap-1">
          {scans.map((scan) => (
            <button
              key={scan.id}
              type="button"
              onClick={() => toggle(scan.id)}
              aria-pressed={selected.includes(scan.id)}
              // The saved-scans list already has a button with this scan's
              // name that does something else entirely — it loads the filter
              // into the builder. Two controls with one accessible name is a
              // genuine ambiguity for anyone navigating by name, so this one
              // says what it does.
              aria-label={`Compare ${scan.name}`}
              className={cn(
                'rounded-md border px-2.5 py-1 text-xs font-medium transition-colors',
                selected.includes(scan.id)
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-border text-muted-foreground hover:text-foreground',
              )}
            >
              {scan.name}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <label className="text-[11px] uppercase tracking-wider text-muted-foreground">
            Against portfolio
          </label>
          <select
            className="rounded-md border border-input bg-background px-2 py-1 text-xs"
            aria-label="Against portfolio"
            value={portfolioId}
            onChange={(event) => setPortfolioId(event.target.value)}
          >
            <option value="">none — just the filters</option>
            {(portfolios ?? []).map((portfolio) => (
              <option key={portfolio.id} value={portfolio.id}>
                {portfolio.name}
              </option>
            ))}
          </select>
          <Button
            size="sm"
            disabled={selected.length === 0 || compare.isPending}
            onClick={() => compare.mutate()}
          >
            {compare.isPending ? 'Running…' : `Compare ${String(selected.length)}`}
          </Button>
        </div>

        {error && <p className="text-[11px] text-red-400">{error}</p>}

        {result && <ComparisonTable result={result} nameOf={nameOf} />}
      </CardContent>
    </Card>
  );
}

function ComparisonTable({
  result,
  nameOf,
}: {
  result: ComparisonDto;
  nameOf: Map<string, string>;
}) {
  const broken = result.methods.filter((method) => method.error !== null);

  return (
    <div className="space-y-2">
      {broken.map((method) => (
        <p key={method.scanId} className="text-[11px] text-amber-300">
          &ldquo;{method.name}&rdquo; could not run: {method.error}. The other filters still ran,
          and this column is empty rather than missing.
        </p>
      ))}

      {result.rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          None of these filters matched anything. That is a result, not a failure — the per-filter
          counts below say how many symbols each one managed to judge, which is how &ldquo;nothing
          matched&rdquo; is told apart from &ldquo;nothing could be judged&rdquo;.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">
              Symbols by how many of the chosen filters flagged them
            </caption>
            <thead>
              <tr className="border-b border-border text-[11px] uppercase tracking-wider text-muted-foreground">
                <th scope="col" className="px-2 py-2 text-left font-semibold">
                  Symbol
                </th>
                <th scope="col" className="px-2 py-2 text-left font-semibold">
                  Sector
                </th>
                {result.methods.map((method) => (
                  <th
                    key={method.scanId}
                    scope="col"
                    className="px-2 py-2 text-center font-semibold"
                    title={method.summary.join(' · ')}
                  >
                    {method.name}
                  </th>
                ))}
                <th scope="col" className="px-2 py-2 text-center font-semibold">
                  Flagged by
                </th>
                {result.portfolioId !== null && (
                  <th scope="col" className="px-2 py-2 text-left font-semibold">
                    Against your book
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {result.rows.map((row) => (
                <tr key={row.symbol} className="border-b border-border/60 last:border-0">
                  <th scope="row" className="px-2 py-2 text-left font-mono font-medium">
                    {row.symbol}
                  </th>
                  <td className="px-2 py-2 text-xs text-muted-foreground">{row.sector ?? '—'}</td>
                  {result.methods.map((method) => (
                    <td key={method.scanId} className="px-2 py-2 text-center">
                      {row.flaggedBy.includes(method.scanId) ? (
                        <Check
                          className="mx-auto h-3.5 w-3.5 text-primary"
                          aria-label={`flagged by ${nameOf.get(method.scanId) ?? method.name}`}
                        />
                      ) : (
                        <Minus
                          className="mx-auto h-3 w-3 text-muted-foreground/40"
                          aria-label="not flagged"
                        />
                      )}
                    </td>
                  ))}
                  <td className="px-2 py-2 text-center tabular font-semibold">{row.agreement}</td>
                  {result.portfolioId !== null && (
                    <td className="px-2 py-2 text-xs">
                      {/*
                        A list, not a run of spans. Two findings rendered
                        inline ran into each other — "Already 10.6% of this
                        portfolioTechnology is already 33.6%" — which reads as
                        one garbled sentence rather than two facts.
                      */}
                      <ul className="space-y-0.5">
                        {row.fit.map((finding) => (
                          <li
                            key={finding.code}
                            className={cn(
                              finding.severity === 'BREACH'
                                ? 'text-loss'
                                : finding.severity === 'WATCH'
                                  ? 'text-amber-300'
                                  : 'text-muted-foreground',
                            )}
                            title={finding.detail}
                          >
                            {finding.title}
                          </li>
                        ))}
                      </ul>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/*
        Always rendered, matches or not. A filter that judged forty symbols and
        matched none is a different fact from one that could judge none of
        them, and the difference is invisible from the table alone — which is
        exactly the case where the table is empty.
      */}
      <dl className="grid gap-x-4 gap-y-1 border-t border-border pt-2 text-[11px] sm:grid-cols-2">
        {result.methods.map((method) => (
          <div key={method.scanId} className="flex items-baseline justify-between gap-2">
            <dt className="truncate text-muted-foreground">{method.name}</dt>
            <dd className="shrink-0 tabular text-muted-foreground">
              {method.error !== null ? (
                <span className="text-amber-300">could not run</span>
              ) : (
                <>
                  {method.matched} of {method.evaluated} judged
                  {method.notEvaluable.length > 0
                    ? `, ${String(method.notEvaluable.length)} unjudgeable`
                    : ''}
                </>
              )}
            </dd>
          </div>
        ))}
      </dl>

      <ul className="space-y-0.5 border-t border-border pt-2">
        {result.caveats.map((caveat) => (
          <li key={caveat} className="text-[11px] text-muted-foreground">
            · {caveat}
          </li>
        ))}
      </ul>
    </div>
  );
}
