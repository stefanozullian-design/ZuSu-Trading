import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Pencil, Plus, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, explainApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAuth } from '@/hooks/useAuth';
import { KillSwitch } from '@/components/KillSwitch';
import { PortfolioStats } from '@/components/PortfolioStats';
import { PositionsTable } from '@/components/PositionsTable';
import { RiskMonitor } from '@/components/RiskMonitor';
import { SystemHealthPanel } from '@/components/SystemHealthPanel';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import type { AutomationConfig, PortfolioSummary } from '@/lib/types';

export function DashboardPage() {
  const [showClosed, setShowClosed] = useState(false);

  const {
    data: portfolios,
    isLoading,
    error,
  } = useQuery({
    queryKey: ['portfolios', showClosed],
    queryFn: () =>
      api<PortfolioSummary[]>(`/api/portfolios?includeClosed=${showClosed ? 'true' : 'false'}`),
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
      <div className="mx-auto w-full max-w-2xl space-y-3 p-6">
        <Card>
          <CardHeader>
            <CardTitle>No portfolios yet</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            Nothing has been shared with this account. Make one below and it becomes yours.
          </CardContent>
        </Card>
        <NewPortfolio />
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-7xl space-y-4 px-3 py-4 sm:px-6">
      <div className="flex flex-wrap items-center gap-2">
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
        <button
          type="button"
          className="shrink-0 text-[11px] text-muted-foreground underline-offset-2 hover:underline"
          onClick={() => setShowClosed(!showClosed)}
        >
          {showClosed ? 'Hide closed' : 'Show closed'}
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <NewPortfolio />
        {selected && <ManagePortfolio portfolio={selected} />}
      </div>

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

/**
 * Making a portfolio.
 *
 * There was no screen for this at all: the capability existed in the API and
 * the only way to reach it was a hand-written request, which meant a fresh
 * install's first experience was a dead end. The environment is the one field
 * worth pausing over, and it is fixed for the portfolio's life — so it is
 * stated here rather than buried in a tooltip.
 */
function NewPortfolio() {
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [capital, setCapital] = useState('');
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () =>
      api<PortfolioSummary>('/api/portfolios', {
        method: 'POST',
        body: { name, environment: 'DEMO', initialCapital: capital, baseCurrency: 'USD' },
      }),
    onSuccess: async () => {
      setError(null);
      setName('');
      setCapital('');
      setOpen(false);
      await queryClient.invalidateQueries({ queryKey: ['portfolios'] });
    },
    onError: (err: Error) => setError(explainApiError(err)),
  });

  if (!can('portfolio:write')) return null;

  if (!open) {
    return (
      <Button variant="outline" size="sm" className="w-fit" onClick={() => setOpen(true)}>
        <Plus className="mr-1 h-3.5 w-3.5" aria-hidden />
        New portfolio
      </Button>
    );
  }

  return (
    <Card className="max-w-xl">
      <CardHeader>
        <CardTitle>New portfolio</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-xs">
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="block space-y-1">
            <span className="block text-[10px] uppercase tracking-wider text-muted-foreground">
              Name
            </span>
            <Input
              id="new-portfolio-name"
              className="h-8 text-xs"
              aria-label="Portfolio name"
              placeholder="My portfolio"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="block space-y-1">
            <span className="block text-[10px] uppercase tracking-wider text-muted-foreground">
              Starting cash
            </span>
            <Input
              id="new-portfolio-capital"
              className="h-8 text-xs tabular-nums"
              aria-label="Starting cash"
              inputMode="decimal"
              placeholder="25000"
              value={capital}
              onChange={(e) => setCapital(e.target.value)}
            />
          </label>
        </div>

        <p className="text-[11px] text-muted-foreground">
          It will be a <strong>DEMO</strong> portfolio: simulated prices, a simulated venue, nothing
          that can reach a real market. A portfolio is bound to its environment for life, so this
          cannot be switched later — which is what stops demo credentials ever reaching real money.
        </p>
        <p className="text-[11px] text-muted-foreground">
          Starting cash also sets the opening risk limits: 2% of it as the daily loss limit, 10% as
          the largest single position.
        </p>

        {error && (
          <p className="rounded-md border border-red-500/30 bg-red-500/5 p-2 text-[11px] text-red-400">
            {error}
          </p>
        )}

        <div className="flex gap-2">
          <Button
            size="sm"
            className="flex-1"
            disabled={name.trim().length < 2 || !(Number(capital) > 0) || create.isPending}
            onClick={() => create.mutate()}
          >
            {create.isPending ? 'Creating…' : 'Create it'}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Renaming and closing.
 *
 * Closing rather than deleting, and the button says so. Every portfolio is
 * referenced by append-only audit rows from the moment it is created, so
 * erasing one would mean rewriting a trading record — which the database
 * refuses, and rightly. A closed portfolio leaves every picker in the app and
 * keeps its history, which is what people actually want from "delete" when
 * they made one by mistake.
 */
function ManagePortfolio({ portfolio }: { portfolio: PortfolioSummary }) {
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(portfolio.name);
  const [error, setError] = useState<string | null>(null);

  const patch = useMutation({
    mutationFn: (body: { name?: string; isActive?: boolean }) =>
      api<PortfolioSummary>(`/api/portfolios/${portfolio.id}`, { method: 'PATCH', body }),
    onSuccess: async () => {
      setError(null);
      setRenaming(false);
      await queryClient.invalidateQueries({ queryKey: ['portfolios'] });
    },
    onError: (err: Error) => setError(explainApiError(err)),
  });

  if (!can('portfolio:write')) return null;

  if (renaming) {
    return (
      <div className="flex flex-wrap items-center gap-1.5">
        <Input
          id="rename-portfolio"
          className="h-7 w-52 text-xs"
          aria-label="New portfolio name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && name.trim().length >= 2) patch.mutate({ name: name.trim() });
            if (e.key === 'Escape') setRenaming(false);
          }}
        />
        <Button
          size="sm"
          variant="outline"
          disabled={name.trim().length < 2 || patch.isPending}
          onClick={() => patch.mutate({ name: name.trim() })}
        >
          <Check className="h-3.5 w-3.5" aria-hidden />
          <span className="sr-only">Save name</span>
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setRenaming(false)}>
          <X className="h-3.5 w-3.5" aria-hidden />
          <span className="sr-only">Cancel rename</span>
        </Button>
        {error && <span className="text-[11px] text-red-400">{error}</span>}
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        size="sm"
        variant="outline"
        onClick={() => {
          setName(portfolio.name);
          setRenaming(true);
        }}
      >
        <Pencil className="mr-1 h-3.5 w-3.5" aria-hidden />
        Rename
      </Button>

      {portfolio.isActive ? (
        <Button
          size="sm"
          variant="ghost"
          disabled={patch.isPending}
          onClick={() => patch.mutate({ isActive: false })}
          title="Hides it from every list. The history is kept and it can be reopened."
        >
          Close
        </Button>
      ) : (
        <Button
          size="sm"
          variant="ghost"
          disabled={patch.isPending}
          onClick={() => patch.mutate({ isActive: true })}
        >
          Reopen
        </Button>
      )}

      {error && <span className="max-w-md text-[11px] text-amber-400">{error}</span>}
    </div>
  );
}
