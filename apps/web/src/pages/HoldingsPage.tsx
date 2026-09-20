import { PositionsTable } from '@/components/PositionsTable';
import { ImportPosition } from '@/components/ImportPosition';
import { RecordTrade } from '@/components/RecordTrade';
import { TradeHistory } from '@/components/TradeHistory';
import { useAuth } from '@/hooks/useAuth';
import { usePortfolios } from '@/hooks/usePortfolios';
import { useSelectedPortfolio } from '@/hooks/useSelectedPortfolio';

/**
 * Holdings.
 *
 * One page for the whole book-keeping job, because it is one job done in one
 * sitting: open a brokerage statement, see what the book thinks is held,
 * correct it, and check the corrections landed. Those four things used to be
 * on three different pages, which meant the statement had to be held in your
 * head while you navigated between them.
 *
 * The order down the page is the order the work happens in — what is held,
 * what you did, what has been entered, and last the one-off declaration of
 * shares that predate this platform, which is rare enough that it stays
 * collapsed until asked for.
 */
export function HoldingsPage() {
  const { can } = useAuth();
  const { portfolios } = usePortfolios();
  const { selectedId: id, select } = useSelectedPortfolio(portfolios);
  const canWrite = can('portfolio:write');

  return (
    <main className="mx-auto w-full max-w-7xl space-y-3 px-3 py-4 sm:px-6">
      <div className="flex flex-wrap items-center gap-2">
        <select
          className="rounded-md border border-input bg-background px-2 py-1 text-xs"
          aria-label="Portfolio"
          value={id}
          onChange={(event) => select(event.target.value)}
        >
          {(portfolios ?? []).map((portfolio) => (
            <option key={portfolio.id} value={portfolio.id}>
              {portfolio.name} · {portfolio.environment}
            </option>
          ))}
        </select>
        <p className="text-[11px] text-muted-foreground">
          Nothing on this page reaches a broker. It records what you have already done.
        </p>
      </div>

      {id === '' ? (
        <p className="text-sm text-muted-foreground">
          No portfolio to show. Create one on the dashboard first.
        </p>
      ) : (
        <div className="grid gap-4 lg:grid-cols-3 lg:items-start">
          <div className="space-y-4 lg:col-span-2">
            <PositionsTable portfolioId={id} />
            <TradeHistory portfolioId={id} />
          </div>
          <div className="space-y-4">
            <RecordTrade portfolioId={id} />
            <ImportPosition portfolioId={id} canWrite={canWrite} />
          </div>
        </div>
      )}
    </main>
  );
}
