import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Pencil, Plus, Trash2, Users, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, explainApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAuth } from '@/hooks/useAuth';
import { useSelectedPortfolio } from '@/hooks/useSelectedPortfolio';
import { usePortfolios } from '@/hooks/usePortfolios';
import { useViewedPortfolios } from '@/hooks/useViewedPortfolios';
import { CombinedView } from '@/components/CombinedView';
import { OwnersPanel } from '@/components/OwnersPanel';
import { UNASSIGNED, useOwnerFilter } from '@/hooks/useOwnerFilter';
import {
  ENVIRONMENT_LABEL,
  ENVIRONMENT_TONE,
  EnvironmentFilter,
  OBJECTIVE_TITLES,
  ObjectivePicker,
  OwnerFilter,
  OwnerPicker,
} from '@/components/Owners';
import { useEnvironmentFilter } from '@/hooks/useEnvironmentFilter';
import { KillSwitch } from '@/components/KillSwitch';
import { PortfolioStats } from '@/components/PortfolioStats';
import { PositionsTable } from '@/components/PositionsTable';
import { RiskMonitor } from '@/components/RiskMonitor';
import { SystemHealthPanel } from '@/components/SystemHealthPanel';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import type { EnvironmentInfo, PortfolioObjective, PortfolioSummary } from '@/lib/types';

export function DashboardPage() {
  const { can } = useAuth();
  const [showClosed, setShowClosed] = useState(false);
  const [managingOwners, setManagingOwners] = useState(false);
  // A viewer cannot read the owner roster at all, so the way in is not shown
  // rather than shown and then refused.
  const canSeeOwners = can('client:read');
  const { ownerId, setOwnerId } = useOwnerFilter();

  const {
    portfolios: allPortfolios,
    isLoading,
    error,
  } = usePortfolios({ includeClosed: showClosed });
  const { environment: environmentFilter, setEnvironment } = useEnvironmentFilter();

  // Filtered before anything downstream sees it, so a remembered selection
  // that the filter hides falls back the same way a closed one does.
  const environmentsPresent = [...new Set((allPortfolios ?? []).map((p) => p.environment))].sort();
  const portfolios = allPortfolios?.filter(
    (p) => environmentFilter === null || p.environment === environmentFilter,
  );

  // Shared with every other page, so clicking through to Trading keeps the
  // book you were looking at. Still exactly one: every page that commits
  // anything deals with a single portfolio, and this is the one it will use.
  const { selectedId, select: setSelectedId } = useSelectedPortfolio(portfolios);

  // The dashboard alone may show several at once. Looking at a person's books
  // together is a reasonable way to answer "how are they doing"; acting on
  // several at once is not, which is why this stops here.
  const { viewedIds, toggle, only, isViewed } = useViewedPortfolios(portfolios);

  const viewed = (portfolios ?? []).filter((p) => viewedIds.includes(p.id));

  // The book the other pages will use follows the one being looked at here.
  // Left to drift, clicking through to Trading would land on a different
  // portfolio from the one on screen — which is precisely the mistake the
  // owner scoping exists to prevent, arriving by another route.
  useEffect(() => {
    const first = viewed[0];
    if (first && first.id !== selectedId) setSelectedId(first.id);
  }, [viewed, selectedId, setSelectedId]);
  const single = viewed.length === 1 ? viewed[0]! : null;

  if (isLoading) {
    return <p className="p-6 text-sm text-muted-foreground">Loading portfolios…</p>;
  }
  if (error) {
    // The bare sentence was a dead end: it named what failed and nothing about
    // why, so the only way forward was to guess. The server's own message is
    // usually the whole answer.
    return (
      <div className="mx-auto w-full max-w-2xl space-y-2 p-6">
        <p className="text-sm text-loss">Could not load portfolios.</p>
        <p className="rounded-md border border-red-500/30 bg-red-500/5 p-2 text-xs text-red-300">
          {error instanceof Error ? explainApiError(error) : String(error)}
        </p>
        <p className="text-xs text-muted-foreground">
          If this followed an update, the window ZuSu started in will say more. Closing it and
          double-clicking the ZuSu icon again re-runs the checks that keep the database and the code
          that reads it in step.
        </p>
      </div>
    );
  }
  if (!portfolios?.length) {
    return (
      <div className="mx-auto w-full max-w-2xl space-y-3 p-6">
        <div className="flex flex-wrap items-center gap-3">
          <OwnerFilter ownerId={ownerId} onChange={setOwnerId} />
          {canSeeOwners && (
            <button
              type="button"
              className="text-[11px] text-muted-foreground underline-offset-2 hover:underline"
              onClick={() => setManagingOwners(!managingOwners)}
            >
              {managingOwners ? 'Hide owners' : 'Manage owners'}
            </button>
          )}
        </div>

        {managingOwners && <OwnersPanel onClose={() => setManagingOwners(false)} />}

        <Card>
          <CardHeader>
            <CardTitle>{ownerId ? 'Nothing for this owner' : 'No portfolios yet'}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-muted-foreground">
            {/*
              An empty list means two different things, and saying the wrong one
              sends a person looking for a portfolio that is simply filtered out.
            */}
            {ownerId ? (
              <p>
                This person has no portfolios here yet. Choose <strong>Everyone</strong> above to
                see the rest, or make one for them below.
              </p>
            ) : (
              <p>Nothing has been shared with this account. Make one below and it becomes yours.</p>
            )}
          </CardContent>
        </Card>
        <NewPortfolio defaultOwnerId={ownerId === UNASSIGNED ? null : ownerId} />
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-7xl space-y-4 px-3 py-4 sm:px-6">
      <div className="flex flex-wrap items-center gap-3">
        <OwnerFilter ownerId={ownerId} onChange={setOwnerId} />
        <EnvironmentFilter
          environment={environmentFilter}
          onChange={setEnvironment}
          available={environmentsPresent}
        />
        {canSeeOwners && (
          <button
            type="button"
            className="text-[11px] text-muted-foreground underline-offset-2 hover:underline"
            onClick={() => setManagingOwners(!managingOwners)}
          >
            {managingOwners ? 'Hide owners' : 'Manage owners'}
          </button>
        )}
      </div>

      {managingOwners && <OwnersPanel onClose={() => setManagingOwners(false)} />}

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-2 overflow-x-auto pb-1">
          {portfolios.map((portfolio) => (
            <button
              key={portfolio.id}
              type="button"
              aria-pressed={isViewed(portfolio.id)}
              // A plain click means "just this one", which is what a click on
              // a list almost always means. Ctrl or ⌘ adds to the view — the
              // same gesture every file list has used for thirty years.
              onClick={(event) => {
                if (event.ctrlKey || event.metaKey) {
                  toggle(portfolio.id);
                } else {
                  only(portfolio.id);
                  setSelectedId(portfolio.id);
                }
              }}
              className={cn(
                'shrink-0 rounded-md border px-3 py-1.5 text-left text-sm transition-colors',
                isViewed(portfolio.id)
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-border text-muted-foreground hover:bg-muted',
              )}
            >
              <span className="flex items-center gap-2">
                {portfolio.name}
                {/*
                  Coloured by environment, the same colours the banner uses:
                  practice blue, paper amber. Two portfolios with the same name
                  and different prices are otherwise told apart only by reading.
                */}
                <span
                  className={cn(
                    'rounded border px-1 text-[10px] uppercase',
                    ENVIRONMENT_TONE[portfolio.environment] ?? 'border-border',
                  )}
                >
                  {ENVIRONMENT_LABEL[portfolio.environment] ?? portfolio.environment}
                </span>
              </span>
              {/*
                Whose it is, on the tab itself. Two people can each have a
                "Retirement", so the name alone no longer identifies a book —
                and picking the wrong one is not a small mistake here.
              */}
              <span className="mt-0.5 block text-[10px] opacity-70">
                {portfolio.clientName ?? 'Unassigned'}
                {portfolio.objective ? ` · ${OBJECTIVE_TITLES[portfolio.objective]}` : ''}
              </span>
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
        {/*
          Filtered to one person, "New portfolio" means one for them. Creating
          it unassigned would make it vanish from the very list being looked
          at, which reads as the creation having failed.
        */}
        <NewPortfolio defaultOwnerId={ownerId === UNASSIGNED ? null : ownerId} />
        {single && <ManagePortfolio portfolio={single} />}
        {portfolios.length > 1 && (
          <span className="text-[11px] text-muted-foreground">
            {viewed.length > 1
              ? `Showing ${String(viewed.length)} portfolios together.`
              : 'Ctrl-click (⌘ on a Mac) to show more than one together.'}
          </span>
        )}
        {viewed.length > 1 && (
          <button
            type="button"
            className="text-[11px] text-muted-foreground underline-offset-2 hover:underline"
            onClick={() => {
              only(viewed[0]!.id);
              setSelectedId(viewed[0]!.id);
            }}
          >
            Show just one
          </button>
        )}
      </div>

      {viewed.length > 1 && <CombinedView portfolios={viewed} />}

      {single && (
        <>
          <PortfolioStats portfolio={single} />

          {/*
            Holdings, recording and the recorded history moved to the Holdings
            page: they are one sitting's work with a brokerage statement open,
            and splitting them across pages meant carrying the statement in
            your head between them. What stays here is the state of the book
            rather than the editing of it.
          */}
          <div className="grid gap-4 lg:grid-cols-3 lg:items-start">
            <div className="space-y-4 lg:col-span-2">
              <PositionsTable portfolioId={single.id} />
            </div>

            <div className="space-y-4 lg:sticky lg:top-16">
              <KillSwitch portfolio={single} />
              <RiskMonitor portfolioId={single.id} />
              <SystemHealthPanel />
            </div>
          </div>
        </>
      )}
    </div>
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
function NewPortfolio({ defaultOwnerId = null }: { defaultOwnerId?: string | null }) {
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [capital, setCapital] = useState('');
  const [ownerId, setOwnerId] = useState<string | null>(defaultOwnerId);
  const [objective, setObjective] = useState<PortfolioObjective | null>(null);
  /**
   * Paper by default wherever real bars exist.
   *
   * Practice prices are for finding your way around an installation that has
   * no market-data provider yet; on one that has, a practice portfolio
   * produces a track record about a market that never existed. Defaulting to
   * it made the useless option the easy one.
   */
  const { data: deployment } = useQuery({
    queryKey: ['environment'],
    queryFn: () => api<EnvironmentInfo>('/api/system/environment'),
    staleTime: 5 * 60_000,
  });
  const [environment, setEnvironment] = useState<'DEMO' | 'PAPER' | null>(null);
  const chosen: 'DEMO' | 'PAPER' =
    environment ?? (deployment?.marketDataConfigured ? 'PAPER' : 'DEMO');
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () =>
      api<PortfolioSummary>('/api/portfolios', {
        method: 'POST',
        body: {
          name,
          environment: chosen,
          initialCapital: capital,
          baseCurrency: 'USD',
          // Omitted rather than sent as null: the API treats an absent owner
          // and an absent objective as "not stated", which is the truth.
          ...(ownerId ? { clientId: ownerId } : {}),
          ...(objective ? { objective } : {}),
        },
      }),
    onSuccess: async () => {
      setError(null);
      setName('');
      setCapital('');
      setObjective(null);
      setEnvironment(null);
      setOpen(false);
      await queryClient.invalidateQueries({ queryKey: ['portfolios'] });
      await queryClient.invalidateQueries({ queryKey: ['owners'] });
    },
    onError: (err: Error) => setError(explainApiError(err)),
  });

  if (!can('portfolio:write')) return null;

  if (!open) {
    return (
      <Button
        variant="outline"
        size="sm"
        className="w-fit"
        onClick={() => {
          // Read the filter at the moment the form opens, not at mount: the
          // person may have changed owner since this button first rendered.
          setOwnerId(defaultOwnerId);
          setOpen(true);
        }}
      >
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

        <label className="block space-y-1">
          <span className="block text-[10px] uppercase tracking-wider text-muted-foreground">
            Prices
          </span>
          <select
            id="new-portfolio-environment"
            aria-label="Prices"
            className="h-8 w-full rounded-md border border-border bg-background px-2 text-xs"
            value={chosen}
            onChange={(e) => setEnvironment(e.target.value === 'PAPER' ? 'PAPER' : 'DEMO')}
          >
            <option value="PAPER">Paper — real market prices</option>
            <option value="DEMO">Practice — invented prices</option>
          </select>
        </label>

        <p className="text-[11px] text-muted-foreground">
          {chosen === 'PAPER' ? (
            <>
              A <strong>PAPER</strong> portfolio runs on the same real prices as the Market page,
              with fills simulated against them. No money moves and no order reaches a broker — but
              the results mean something, because the prices are the market&rsquo;s.
            </>
          ) : (
            <>
              A <strong>DEMO</strong> portfolio runs on prices invented by a simulator. Useful for
              finding your way around; its results say nothing about whether a strategy works,
              because the market it traded never existed.
            </>
          )}
        </p>
        {chosen === 'PAPER' && deployment && !deployment.marketDataConfigured && (
          <p className="rounded-md border border-amber-500/30 bg-amber-500/5 p-2 text-[11px] text-amber-300">
            This installation has no market-data provider, so a paper portfolio has no prices to
            mark against. Its positions will show a dash rather than a value until one is
            configured.
          </p>
        )}
        <p className="text-[11px] text-muted-foreground">
          This cannot be changed afterwards. A portfolio is bound to its environment for life — the
          rule that stops practice credentials ever reaching real money. To switch, make another
          portfolio and record your holdings in it.
        </p>
        <div className="grid gap-2 sm:grid-cols-2">
          <OwnerPicker id="new-portfolio-owner" value={ownerId} onChange={setOwnerId} />
          <ObjectivePicker id="new-portfolio-objective" value={objective} onChange={setObjective} />
        </div>

        <p className="text-[11px] text-muted-foreground">
          {objective === null
            ? 'Starting cash sets the opening risk limits: 2% of it as the daily loss limit, 10% as the largest single position. Saying what the portfolio is for changes those starting limits.'
            : `Starting cash and "${OBJECTIVE_TITLES[objective]}" together set the opening risk limits. They are a starting point, not a ceiling you are stuck with — an administrator can change any of them afterwards.`}
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
  const [reassigning, setReassigning] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmName, setConfirmName] = useState('');
  const [name, setName] = useState(portfolio.name);
  const [error, setError] = useState<string | null>(null);

  const patch = useMutation({
    mutationFn: (body: {
      name?: string;
      isActive?: boolean;
      clientId?: string | null;
      objective?: PortfolioObjective | null;
    }) => api<PortfolioSummary>(`/api/portfolios/${portfolio.id}`, { method: 'PATCH', body }),
    onSuccess: async () => {
      setError(null);
      setRenaming(false);
      await queryClient.invalidateQueries({ queryKey: ['portfolios'] });
      await queryClient.invalidateQueries({ queryKey: ['owners'] });
    },
    onError: (err: Error) => setError(explainApiError(err)),
  });

  const remove = useMutation({
    mutationFn: () =>
      api<null>(
        `/api/portfolios/${portfolio.id}?confirmName=${encodeURIComponent(confirmName.trim())}`,
        { method: 'DELETE' },
      ),
    onSuccess: async () => {
      setError(null);
      setDeleting(false);
      setConfirmName('');
      await queryClient.invalidateQueries({ queryKey: ['portfolios'] });
      await queryClient.invalidateQueries({ queryKey: ['owners'] });
    },
    onError: (err: Error) => setError(explainApiError(err)),
  });

  const switching = useMutation({
    mutationFn: (environment: string) =>
      api<PortfolioSummary>(`/api/portfolios/${portfolio.id}/environment`, {
        method: 'POST',
        body: { environment },
      }),
    onSuccess: async () => {
      setError(null);
      await queryClient.invalidateQueries({ queryKey: ['portfolios'] });
      // The marks, the positions and the performance all change meaning with
      // the environment, so nothing cached about this portfolio survives.
      await queryClient.invalidateQueries({ queryKey: ['positions'] });
      await queryClient.invalidateQueries({ queryKey: ['performance'] });
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

  if (deleting) {
    return (
      <Card className="max-w-xl">
        <CardHeader>
          <CardTitle>Delete “{portfolio.name}”?</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-xs">
          <p className="text-[11px] text-muted-foreground">
            This removes the portfolio and everything that belonged to it — its positions, orders,
            fills, snapshots and cash flows. It cannot be undone.
          </p>
          <p className="text-[11px] text-muted-foreground">
            {/*
              Said plainly, because it is the one thing people assume deleting
              destroys, and it is the one thing it does not.
            */}
            The audit log is not touched. Every entry this portfolio produced stays, and one more is
            written recording what was deleted and by whom.
          </p>
          <p className="text-[11px] text-muted-foreground">
            If you only want it out of the way, <strong>Close</strong> hides it from every list and
            keeps it reopenable.
          </p>

          <label className="block space-y-1">
            <span className="block text-[10px] uppercase tracking-wider text-muted-foreground">
              Type its name to confirm
            </span>
            <Input
              id="confirm-delete-portfolio"
              className="h-8 text-xs"
              aria-label="Type the portfolio name to confirm deletion"
              placeholder={portfolio.name}
              value={confirmName}
              onChange={(e) => setConfirmName(e.target.value)}
            />
          </label>

          {error && <p className="text-[11px] text-red-400">{error}</p>}

          <div className="flex gap-2">
            <Button
              size="sm"
              variant="destructive"
              // Typed exactly, not merely clicked: a confirmation that can be
              // clicked through without reading is not a confirmation.
              disabled={confirmName.trim() !== portfolio.name || remove.isPending}
              onClick={() => remove.mutate()}
            >
              {remove.isPending ? 'Deleting…' : 'Delete permanently'}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setDeleting(false);
                setConfirmName('');
                setError(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (reassigning) {
    const other = portfolio.environment === 'PAPER' ? 'DEMO' : 'PAPER';
    return (
      <Card className="max-w-xl">
        <CardHeader>
          <CardTitle>Who it belongs to, and what it is for</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-xs">
          <div className="grid gap-2 sm:grid-cols-2">
            <OwnerPicker
              id="manage-portfolio-owner"
              value={portfolio.clientId}
              onChange={(clientId) => patch.mutate({ clientId })}
            />
            <ObjectivePicker
              id="manage-portfolio-objective"
              value={portfolio.objective}
              onChange={(objective) => patch.mutate({ objective })}
            />
          </div>
          <p className="text-[11px] text-muted-foreground">
            {/*
              Said plainly, because the opposite is the reasonable assumption:
              the objective picks the limits a portfolio *starts* with, and
              changing it later is a relabelling. It would be worse to quietly
              rewrite the limits of a portfolio that is already holding
              something.
            */}
            Changing what it is for relabels this portfolio. It does not rewrite risk limits that
            are already in force — those are on the Risk page, and only an administrator can change
            them.
          </p>
          {portfolio.environment !== 'LIVE' && (
            <div className="space-y-1 border-t border-border pt-2">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Prices</p>
              <p className="text-[11px] text-muted-foreground">
                This portfolio runs on{' '}
                <strong>
                  {portfolio.environment === 'PAPER'
                    ? 'real market prices'
                    : 'prices invented by a simulator'}
                </strong>
                . Moving it to {other === 'PAPER' ? 'paper' : 'practice'} keeps the holdings and the
                cash, and starts the track record again from the moment you switch — everything
                before it happened under different prices and is not counted as though it happened
                here. Nothing is deleted.
              </p>
              <Button
                size="sm"
                variant="outline"
                disabled={switching.isPending}
                onClick={() => switching.mutate(other)}
              >
                {switching.isPending
                  ? 'Switching…'
                  : `Move to ${other === 'PAPER' ? 'real market prices' : 'practice prices'}`}
              </Button>
            </div>
          )}

          {error && <p className="text-[11px] text-red-400">{error}</p>}
          <Button size="sm" variant="ghost" onClick={() => setReassigning(false)}>
            Done
          </Button>
        </CardContent>
      </Card>
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

      <Button size="sm" variant="outline" onClick={() => setReassigning(true)}>
        <Users className="mr-1 h-3.5 w-3.5" aria-hidden />
        Owner &amp; purpose
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

      {portfolio.environment !== 'LIVE' && (
        <Button
          size="sm"
          variant="ghost"
          className="text-red-400 hover:text-red-300"
          onClick={() => {
            setConfirmName('');
            setError(null);
            setDeleting(true);
          }}
          title="Removes it and everything in it. The audit log is kept."
        >
          <Trash2 className="mr-1 h-3.5 w-3.5" aria-hidden />
          Delete
        </Button>
      )}

      {error && <span className="max-w-md text-[11px] text-amber-400">{error}</span>}
    </div>
  );
}
