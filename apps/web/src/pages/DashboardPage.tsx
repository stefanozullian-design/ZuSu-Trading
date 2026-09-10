import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { KillSwitch } from '@/components/KillSwitch';
import { PhaseNotice } from '@/components/PhaseNotice';
import { PortfolioStats } from '@/components/PortfolioStats';
import { PositionsTable } from '@/components/PositionsTable';
import { RiskMonitor } from '@/components/RiskMonitor';
import { SystemHealthPanel } from '@/components/SystemHealthPanel';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import type { PortfolioSummary } from '@/lib/types';

export function DashboardPage() {
  const {
    data: portfolios,
    isLoading,
    error,
  } = useQuery({
    queryKey: ['portfolios'],
    queryFn: () => api<PortfolioSummary[]>('/api/portfolios'),
    refetchInterval: 15_000,
  });

  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedId && portfolios?.length) setSelectedId(portfolios[0]?.id ?? null);
  }, [portfolios, selectedId]);

  const selected = portfolios?.find((p) => p.id === selectedId) ?? null;

  if (isLoading) {
    return <p className="p-6 text-sm text-muted-foreground">Loading portfolios…</p>;
  }
  if (error) {
    return <p className="p-6 text-sm text-loss">Could not load portfolios.</p>;
  }
  if (!portfolios?.length) {
    return (
      <div className="p-6">
        <Card>
          <CardHeader>
            <CardTitle>No portfolios</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            No portfolio has been shared with this account yet.
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-7xl space-y-4 px-3 py-4 sm:px-6">
      {portfolios.length > 1 && (
        <div className="flex gap-2 overflow-x-auto pb-1">
          {portfolios.map((portfolio) => (
            <button
              key={portfolio.id}
              type="button"
              onClick={() => setSelectedId(portfolio.id)}
              className={cn(
                'shrink-0 rounded-md border px-3 py-1.5 text-sm transition-colors',
                portfolio.id === selectedId
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-border text-muted-foreground hover:bg-muted',
              )}
            >
              {portfolio.name}
              <span className="ml-2 text-[10px] uppercase opacity-70">{portfolio.environment}</span>
            </button>
          ))}
        </div>
      )}

      {selected && (
        <>
          <PortfolioStats portfolio={selected} />

          {/*
            Panel order is the order a trader needs them in (§73): P&L, open
            positions, pending approvals, the kill switch, risk, health. On a
            phone that is simply the stacking order; on a wide screen the same
            two columns form a control-centre grid with the risk column pinned.
          */}
          <div className="grid gap-4 lg:grid-cols-3 lg:items-start">
            <div className="space-y-4 lg:col-span-2">
              <PositionsTable portfolioId={selected.id} />
              <PhaseNotice title="Pending approvals" phase="Phase 9">
                Manual approval of orders opens when the risk engine and order manager are in place.
                Until then no order can be created by any route in this API.
              </PhaseNotice>
            </div>

            <div className="space-y-4 lg:sticky lg:top-16">
              <KillSwitch portfolio={selected} />
              <RiskMonitor portfolioId={selected.id} />
              <SystemHealthPanel />
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            <PhaseNotice title="Active signals" phase="Phase 3">
              Signals appear here once the strategy and signal engines are built. Nothing is
              generating signals yet, so this panel is empty by design rather than by accident.
            </PhaseNotice>
            <PhaseNotice title="Market regime" phase="Phase 6">
              Regime classification (trending, range-bound, volatility state) is computed once the
              indicator and AI engines land.
            </PhaseNotice>
            <PhaseNotice title="Strategy performance" phase="Phase 4">
              Backtest, paper and live performance are compared side by side once the backtesting
              engine exists — reporting simulated results as realised performance would be
              misleading.
            </PhaseNotice>
          </div>
        </>
      )}
    </div>
  );
}
