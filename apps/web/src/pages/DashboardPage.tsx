import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { KillSwitch } from '@/components/KillSwitch';
import { PortfolioStats } from '@/components/PortfolioStats';
import { PositionsTable } from '@/components/PositionsTable';
import { RiskMonitor } from '@/components/RiskMonitor';
import { SystemHealthPanel } from '@/components/SystemHealthPanel';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import type { AutomationConfig, PortfolioSummary } from '@/lib/types';

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
              <ApprovalsPanel portfolioId={selected.id} />
            </div>

            <div className="space-y-4 lg:sticky lg:top-16">
              <KillSwitch portfolio={selected} />
              <RiskMonitor portfolioId={selected.id} />
              <SystemHealthPanel />
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            <RegimePanel />
            <AutomationPanel />
          </div>
        </>
      )}
    </div>
  );
}

/**
 * What is waiting for a person right now.
 *
 * The dashboard's job is to answer "is there anything for me to do", and the
 * only thing this platform ever needs a person for is a decision. So this
 * panel counts recommendations rather than summarising them: the deciding
 * happens on the Trading page, with the reasoning next to each one.
 */
function ApprovalsPanel({ portfolioId }: { portfolioId: string }) {
  const { data } = useQuery({
    queryKey: ['signals', portfolioId],
    queryFn: () =>
      api<{ signals: { id: string; status: string; symbol: string; direction: string }[] }>(
        `/api/strategies/signals?portfolioId=${portfolioId}&limit=100`,
      ),
    refetchInterval: 30_000,
  });

  const waiting = (data?.signals ?? []).filter(
    (signal) => signal.status === 'CREATED' || signal.status === 'PENDING_APPROVAL',
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Waiting for a decision</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {waiting.length === 0 ? (
          <p className="text-muted-foreground">
            Nothing waiting. A recommendation stays here until somebody approves or rejects it —
            nothing sweeps this queue automatically.
          </p>
        ) : (
          <>
            <p className="text-2xl font-semibold tabular-nums">{waiting.length}</p>
            <p className="text-xs text-muted-foreground">
              {waiting
                .slice(0, 6)
                .map((signal) => `${signal.symbol} ${signal.direction}`)
                .join(', ')}
              {waiting.length > 6 && ` and ${String(waiting.length - 6)} more`}
            </p>
          </>
        )}
        <a className="inline-block text-xs text-sky-400 hover:underline" href="/trading">
          Open the trading page →
        </a>
      </CardContent>
    </Card>
  );
}

/**
 * The most recent market-regime classification.
 *
 * Absent rather than NEUTRAL when nothing has classified one: a regime is a
 * claim about the market, and "we have not looked" is a different statement
 * from "it is neutral".
 */
function RegimePanel() {
  const { data } = useQuery({
    queryKey: ['regime'],
    queryFn: () =>
      api<{
        regime: { regime: string; confidence: string; detectedAt: string } | null;
      }>('/api/analysis/regime'),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Market regime</CardTitle>
      </CardHeader>
      <CardContent className="space-y-1 text-sm">
        {data?.regime ? (
          <>
            <p className="text-lg font-medium">{data.regime.regime.replace('_', ' ')}</p>
            <p className="text-xs text-muted-foreground">
              confidence {Number(data.regime.confidence).toFixed(2)} · classified{' '}
              {new Date(data.regime.detectedAt).toLocaleString()}
            </p>
          </>
        ) : (
          <p className="text-xs text-muted-foreground">
            Nothing has classified one. Regime comes from the analysis layer, which needs an API key
            this deployment does not have — so the panel says nothing rather than guessing
            &ldquo;neutral&rdquo;.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Where automation stands right now.
 *
 * The one number on this dashboard worth being unambiguous about: how many
 * strategies can place an order without anyone clicking. It is read from the
 * live configurations rather than described, because a reassuring sentence
 * that is not checked against the data is how this goes wrong.
 */
function AutomationPanel() {
  const { data: configs } = useQuery({
    queryKey: ['automation-configs'],
    queryFn: () => api<AutomationConfig[]>('/api/automation/configs'),
    refetchInterval: 30_000,
  });

  const automatic = (configs ?? []).filter(
    (config) => config.mode === 'LIMITED_AUTO' || config.mode === 'FULL_AUTO',
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Automation</CardTitle>
      </CardHeader>
      <CardContent className="space-y-1.5 text-xs">
        {automatic.length === 0 ? (
          <p>
            <span className="font-medium text-emerald-400">Nothing trades on its own.</span> All{' '}
            {String((configs ?? []).length)} configurations wait for a person on every order.
          </p>
        ) : (
          <>
            <p className="font-medium text-amber-400">
              {String(automatic.length)} of {String((configs ?? []).length)} configurations place
              orders without a click.
            </p>
            <ul className="space-y-0.5 text-[11px] text-muted-foreground">
              {automatic.map((config) => (
                <li key={config.configId}>
                  · {config.strategyName} on {config.portfolioName} — {config.mode}
                </li>
              ))}
            </ul>
          </>
        )}
        <p className="text-[11px] text-muted-foreground">
          Raising a strategy onto an automatic rung takes an administrator, one rung at a time, a
          typed confirmation and eight conditions that all pass — re-checked before every automatic
          order. Lowering it is one button and is never refused.
        </p>
      </CardContent>
    </Card>
  );
}
