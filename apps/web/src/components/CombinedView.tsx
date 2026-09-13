import { useQueries } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { combine } from '@/lib/combine';
import { formatMoney, formatSignedMoney, pnlTone } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { PortfolioSummary, Position } from '@/lib/types';

/**
 * Several portfolios, added up.
 *
 * This answers "how is this person doing overall", and it is the only place in
 * the application that looks at more than one book at once. Nothing here acts:
 * there is no kill switch, no approval queue and no risk monitor, because each
 * of those belongs to exactly one portfolio and a control that did not name
 * one would be the most dangerous thing on the screen.
 *
 * Two figures are deliberately missing rather than computed.
 *
 * **Daily risk used** is a percentage of *that portfolio's* daily loss limit.
 * Two portfolios at 50% are not one portfolio at 100%, or 50%, or any number —
 * the quantity does not exist across books. It is listed per portfolio below
 * instead, where it means something.
 *
 * **Any total containing an unknown** is left blank and explained. The sum of
 * the portfolios that could be marked is not the total; it is a smaller number
 * wearing the total's label.
 */
export function CombinedView({ portfolios }: { portfolios: PortfolioSummary[] }) {
  const total = combine(portfolios);

  const results = useQueries({
    queries: portfolios.map((portfolio) => ({
      queryKey: ['positions', portfolio.id],
      queryFn: () => api<Position[]>(`/api/portfolios/${portfolio.id}/positions`),
      refetchInterval: 15_000,
    })),
  });

  const loading = results.some((r) => r.isPending);
  const failed = results.some((r) => r.isError);
  const nameFor = new Map(portfolios.map((p) => [p.id, p.name]));

  const rows = results
    .flatMap((result, index) =>
      (result.data ?? []).map((position) => ({
        ...position,
        portfolioId: portfolios[index]!.id,
      })),
    )
    .sort((a, b) => a.symbol.localeCompare(b.symbol));

  const currency = total.baseCurrency ?? 'USD';

  // Only name an owner when every one of them belongs to that owner. Taking
  // the first portfolio's owner and putting it on the heading attributed one
  // person's money to another as soon as the selection crossed owners — a
  // quiet falsehood on the largest text on the screen.
  const owners = new Set(portfolios.map((p) => p.clientName ?? 'Unassigned'));
  const sharedOwner = owners.size === 1 ? [...owners][0]! : null;
  const mixedOwners = owners.size > 1;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>
            {total.count} portfolios together
            {sharedOwner ? ` · ${sharedOwner}` : ` · ${String(owners.size)} owners`}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Figure
              label="Daily P&L"
              value={formatSignedMoney(total.dailyPnl, currency)}
              tone={pnlTone(total.dailyPnl)}
              hint={total.dailyPnl === null ? 'not known for all of them' : undefined}
            />
            <Figure
              label="Account value"
              value={formatMoney(total.equity, currency)}
              hint={
                total.equity === null
                  ? 'not known for all of them'
                  : `from ${formatMoney(total.initialCapital, currency)}`
              }
            />
            <Figure
              label="Cash"
              value={formatMoney(total.cashBalance, currency)}
              hint={`${total.openPositions} open position${total.openPositions === 1 ? '' : 's'}`}
            />
            <Figure label="Positions value" value={formatMoney(total.positionsValue, currency)} />
          </div>

          {mixedOwners && (
            // Adding up money belonging to different people is a legitimate
            // thing to look at and a strange thing to be shown without being
            // told, so it is said out loud rather than left to be inferred
            // from the portfolio names.
            <p className="rounded-md border border-sky-500/30 bg-sky-500/5 p-2 text-[11px] text-sky-300">
              These portfolios belong to different people ({[...owners].join(', ')}). The totals
              above add up money that is not all the same person&rsquo;s.
            </p>
          )}
          {total.caveats.map((caveat) => (
            <p
              key={caveat}
              className="rounded-md border border-amber-500/30 bg-amber-500/5 p-2 text-[11px] text-amber-300"
            >
              {caveat}
            </p>
          ))}

          <p className="text-[11px] text-muted-foreground">
            Risk limits belong to one portfolio each, so there is no combined figure for risk used —
            it is shown per portfolio below. Approving, halting and everything else that commits
            still happens one portfolio at a time.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Each of them</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-[10px] uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="py-1 text-left font-semibold">Portfolio</th>
                {mixedOwners && <th className="py-1 text-left font-semibold">Owner</th>}
                <th className="py-1 text-right font-semibold">Account value</th>
                <th className="py-1 text-right font-semibold">Day</th>
                <th className="py-1 text-right font-semibold">Open</th>
                <th className="py-1 text-right font-semibold">Risk used</th>
                <th className="py-1 text-right font-semibold">State</th>
              </tr>
            </thead>
            <tbody>
              {portfolios.map((portfolio) => (
                <tr key={portfolio.id} className="border-t border-border">
                  <td className="py-1.5">{portfolio.name}</td>
                  {mixedOwners && (
                    <td className="py-1.5 text-muted-foreground">
                      {portfolio.clientName ?? 'Unassigned'}
                    </td>
                  )}
                  <td className="py-1.5 text-right tabular-nums">
                    {formatMoney(portfolio.equity, portfolio.baseCurrency)}
                  </td>
                  <td className={cn('py-1.5 text-right tabular-nums', pnlTone(portfolio.dailyPnl))}>
                    {formatSignedMoney(portfolio.dailyPnl, portfolio.baseCurrency)}
                  </td>
                  <td className="py-1.5 text-right tabular-nums">{portfolio.openPositions}</td>
                  <td className="py-1.5 text-right tabular-nums">
                    {portfolio.dailyRiskUsedPct === null
                      ? '—'
                      : `${Number(portfolio.dailyRiskUsedPct).toFixed(0)}%`}
                  </td>
                  <td className="py-1.5 text-right">
                    {portfolio.killSwitchEngaged ? 'HALTED' : portfolio.tradingState}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>All open positions</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {loading && <p className="text-xs text-muted-foreground">Loading positions…</p>}
          {failed && (
            // Not silence: a partial list of somebody's holdings is worse than
            // an admitted failure to load them.
            <p className="text-xs text-loss">
              At least one portfolio&rsquo;s positions could not be loaded, so this list is
              incomplete. Reload, or look at that portfolio on its own.
            </p>
          )}
          {!loading && !failed && rows.length === 0 && (
            <p className="text-xs text-muted-foreground">No open positions in any of them.</p>
          )}
          {rows.length > 0 && (
            <table className="w-full text-xs">
              <thead className="text-[10px] uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="py-1 text-left font-semibold">Symbol</th>
                  <th className="py-1 text-left font-semibold">Portfolio</th>
                  <th className="py-1 text-right font-semibold">Qty</th>
                  <th className="py-1 text-right font-semibold">Entry</th>
                  <th className="py-1 text-right font-semibold">Mark</th>
                  <th className="py-1 text-right font-semibold">Value</th>
                  <th className="py-1 text-right font-semibold">Unrealised</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} className="border-t border-border">
                    <td className="py-1.5 font-medium">{row.symbol}</td>
                    {/*
                      Which book each holding is in. The same symbol can be held
                      by two people at once, and a merged table without this
                      column would show two AAPL lines with no way to tell whose
                      is whose.
                    */}
                    <td className="py-1.5 text-muted-foreground">
                      {nameFor.get(row.portfolioId) ?? '—'}
                    </td>
                    <td className="py-1.5 text-right tabular-nums">{row.quantity}</td>
                    <td className="py-1.5 text-right tabular-nums">{row.averageEntryPrice}</td>
                    <td className="py-1.5 text-right tabular-nums">{row.markPrice ?? '—'}</td>
                    <td className="py-1.5 text-right tabular-nums">
                      {formatMoney(row.marketValue, currency)}
                    </td>
                    <td
                      className={cn('py-1.5 text-right tabular-nums', pnlTone(row.unrealizedPnl))}
                    >
                      {formatSignedMoney(row.unrealizedPnl, currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Figure({
  label,
  value,
  tone,
  hint,
}: {
  label: string;
  value: string;
  tone?: string;
  hint?: string;
}) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <p className={cn('truncate text-xl font-semibold tabular sm:text-2xl', tone)}>{value}</p>
      {hint && <p className="truncate text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}
