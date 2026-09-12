import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUpRight, FlaskConical, Lock, Plus, ShieldCheck } from 'lucide-react';
import { useMemo, useState } from 'react';
import { RuleTreeEditor } from '@/components/strategy/RuleTreeEditor';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { useAuth } from '@/hooks/useAuth';
import { api, explainApiError } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import type {
  PortfolioSummary,
  RuleNode,
  SignalRow,
  Strategy,
  StrategyDefinition,
  StrategyEvaluation,
  StrategyRiskSettings,
  StrategyVersion,
  Watchlist,
} from '@/lib/types';

const TIMEFRAMES = ['5m', '1d'] as const;

/** The promotion ladder, in order. Displayed as a ladder because it is one. */
const LADDER = ['DRAFT', 'BACKTEST', 'PAPER', 'REVIEW', 'APPROVED', 'LIVE'] as const;

/**
 * The strategy builder.
 *
 * The whole page is built around one sentence: a rule is data, never code.
 * What you assemble here is a nested record of conditions that the API
 * evaluates; nothing typed into this page is ever executed.
 *
 * Two more things are deliberate and visible on screen:
 *
 *   - **A version cannot be edited.** There is no edit form, because the
 *     database refuses the update. Changing a rule adds a version, which
 *     starts back at DRAFT and climbs the ladder again.
 *   - **A signal is a recommendation.** Evaluating a strategy records signals
 *     at CREATED and stops there. No button on this page can place an order —
 *     not because it is disabled, but because no such route exists.
 */
export function StrategiesPage() {
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const canWrite = can('strategy:write');
  const canPromote = can('strategy:promote');

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [evaluation, setEvaluation] = useState<StrategyEvaluation | null>(null);
  const [portfolioId, setPortfolioId] = useState('');

  const { data: strategies } = useQuery({
    queryKey: ['strategies'],
    queryFn: () => api<{ strategies: Strategy[] }>('/api/strategies'),
  });

  const { data: watchlists } = useQuery({
    queryKey: ['watchlists'],
    queryFn: () => api<{ watchlists: Watchlist[] }>('/api/market-data/watchlists'),
  });

  const { data: portfolios } = useQuery({
    queryKey: ['portfolios'],
    queryFn: () => api<PortfolioSummary[]>('/api/portfolios'),
  });

  const effectivePortfolioId = portfolioId || (portfolios?.[0]?.id ?? '');

  const { data: signals } = useQuery({
    queryKey: ['signals', effectivePortfolioId],
    queryFn: () =>
      api<{ signals: SignalRow[] }>(
        `/api/strategies/signals?portfolioId=${effectivePortfolioId}&limit=25`,
      ),
    enabled: Boolean(effectivePortfolioId),
    refetchInterval: 30_000,
  });

  const list = strategies?.strategies ?? [];
  const selected = useMemo(
    () => list.find((s) => s.id === selectedId) ?? list[0] ?? null,
    [list, selectedId],
  );

  const promote = useMutation({
    mutationFn: ({ versionId, stage }: { versionId: string; stage: string }) =>
      api<StrategyVersion>(`/api/strategies/versions/${versionId}/promote`, {
        method: 'POST',
        body: { stage },
      }),
    onSuccess: () => {
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ['strategies'] });
    },
    onError: (err: Error) => setError(explainApiError(err)),
  });

  const archive = useMutation({
    mutationFn: ({ id, archived }: { id: string; archived: boolean }) =>
      api<Strategy>(`/api/strategies/${id}/archive`, { method: 'POST', body: { archived } }),
    onSuccess: () => {
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ['strategies'] });
    },
    onError: (err: Error) => setError(explainApiError(err)),
  });

  const evaluate = useMutation({
    mutationFn: ({ versionId, dryRun }: { versionId: string; dryRun: boolean }) =>
      api<StrategyEvaluation>(`/api/strategies/versions/${versionId}/evaluate`, {
        method: 'POST',
        body: { portfolioId: effectivePortfolioId, dryRun },
      }),
    onSuccess: (data) => {
      setEvaluation(data);
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ['signals'] });
    },
    onError: (err: Error) => {
      setEvaluation(null);
      setError(explainApiError(err));
    },
  });

  return (
    <main className="mx-auto w-full max-w-7xl space-y-3 px-3 py-4 sm:px-6">
      <div className="grid gap-3 lg:grid-cols-[260px_minmax(0,1fr)]">
        <div className="space-y-3">
          <Card>
            <CardHeader>
              <CardTitle>Strategies</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1">
              {list.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  None yet. Build one on the right — it starts as a draft and nothing runs until a
                  person walks it up the ladder.
                </p>
              )}
              {list.map((strategy) => (
                <button
                  key={strategy.id}
                  type="button"
                  onClick={() => {
                    setSelectedId(strategy.id);
                    setEvaluation(null);
                  }}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors',
                    selected?.id === strategy.id
                      ? 'bg-muted text-foreground'
                      : 'text-muted-foreground hover:bg-muted/60',
                  )}
                  aria-current={selected?.id === strategy.id}
                >
                  <span className="truncate">{strategy.name}</span>
                  {strategy.liveVersion && (
                    <Badge className="ml-auto border-emerald-500/40 text-emerald-400">live</Badge>
                  )}
                  {strategy.isArchived && (
                    <span className="ml-auto text-[10px] uppercase">archived</span>
                  )}
                </button>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Signals</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <select
                className="w-full rounded-md border border-input bg-background px-2 py-1 text-xs"
                aria-label="Portfolio"
                value={effectivePortfolioId}
                onChange={(e) => setPortfolioId(e.target.value)}
              >
                {(portfolios ?? []).map((portfolio) => (
                  <option key={portfolio.id} value={portfolio.id}>
                    {portfolio.name} · {portfolio.environment}
                  </option>
                ))}
              </select>

              {(signals?.signals ?? []).length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No signals recorded for this portfolio.
                </p>
              ) : (
                <ul className="space-y-1.5">
                  {(signals?.signals ?? []).map((signal) => (
                    <li key={signal.id} className="rounded-md border border-border p-2 text-xs">
                      <div className="flex items-center gap-1.5">
                        <span className="font-medium">{signal.symbol}</span>
                        <span className="text-muted-foreground">{signal.direction}</span>
                        <Badge className="ml-auto">{signal.status}</Badge>
                      </div>
                      <p className="mt-1 tabular-nums text-muted-foreground">
                        at {signal.referencePrice}
                        {signal.suggestedStop && <> · stop {signal.suggestedStop}</>}
                        {signal.suggestedTarget && <> · target {signal.suggestedTarget}</>}
                      </p>
                      <p className="text-[11px] text-muted-foreground">
                        {signal.strategyName}
                        {signal.strategyVersion !== null &&
                          ` v${String(signal.strategyVersion)}`} ·{' '}
                        {formatDateTime(signal.createdAt)}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
              <p className="text-[11px] text-muted-foreground">
                A signal is a recommendation. Turning one into an order is a separate, human step
                that this page cannot take.
              </p>
            </CardContent>
          </Card>
        </div>

        <div className="space-y-3">
          {error && (
            <p className="rounded-md border border-red-500/30 bg-red-500/5 p-2 text-xs text-red-400">
              {error}
            </p>
          )}

          {selected && (
            <Card>
              <CardHeader className="flex-row items-center justify-between gap-2">
                <CardTitle>{selected.name}</CardTitle>
                {canWrite && !selected.liveVersion && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-xs"
                    onClick={() =>
                      archive.mutate({ id: selected.id, archived: !selected.isArchived })
                    }
                  >
                    {selected.isArchived ? 'Unarchive' : 'Archive'}
                  </Button>
                )}
              </CardHeader>
              <CardContent className="space-y-3">
                {selected.description && (
                  <p className="text-xs text-muted-foreground">{selected.description}</p>
                )}

                {selected.versions.map((version) => (
                  <div key={version.id} className="rounded-md border border-border p-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-xs font-medium">v{version.version}</span>
                      <StageLadder stage={version.stage} />
                      {version.frozen && (
                        <span
                          className="flex items-center gap-1 text-[11px] text-muted-foreground"
                          title="A definition is frozen when written. Changing it means adding a version."
                        >
                          <Lock className="h-3 w-3" aria-hidden />
                          frozen
                        </span>
                      )}
                    </div>

                    {version.definition ? (
                      <>
                        <p className="mt-1.5 text-xs">
                          <span className="text-muted-foreground">entry </span>
                          {version.entrySummary}
                        </p>
                        {version.exitSummary && (
                          <p className="text-xs">
                            <span className="text-muted-foreground">exit </span>
                            {version.exitSummary}
                          </p>
                        )}
                        <p className="text-xs text-muted-foreground">
                          {version.definition.timeframe} ·{' '}
                          {version.definition.stop
                            ? `stop ${version.definition.stop.value} ${version.definition.stop.kind}`
                            : 'no stop — cannot be approved'}
                          {version.definition.target &&
                            ` · target ${version.definition.target.value} ${version.definition.target.kind}`}
                        </p>
                        <p className="text-[11px] text-muted-foreground">
                          needs {version.fieldsUsed.join(', ') || 'no indicators'} ·{' '}
                          {version.changeDescription}
                        </p>
                      </>
                    ) : (
                      <p className="mt-1.5 rounded-md border border-amber-500/30 bg-amber-500/5 p-1.5 text-[11px] text-amber-300">
                        Written in a rule language this build cannot read, so it cannot be evaluated
                        or promoted. Its stage and history are kept — a version is never rewritten —
                        and a new version supersedes it.
                      </p>
                    )}
                    {version.approvedAt && (
                      <p className="flex items-center gap-1 text-[11px] text-emerald-400">
                        <ShieldCheck className="h-3 w-3" aria-hidden />
                        approved {formatDateTime(version.approvedAt)}
                      </p>
                    )}

                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      {canPromote &&
                        nextStages(version.stage).map((stage) => (
                          <Button
                            key={stage}
                            variant="ghost"
                            size="sm"
                            className="text-xs"
                            disabled={promote.isPending}
                            onClick={() => promote.mutate({ versionId: version.id, stage })}
                          >
                            <ArrowUpRight className="mr-1 h-3.5 w-3.5" aria-hidden />
                            {stage === 'RETIRED' ? 'Retire' : `Promote to ${stage}`}
                          </Button>
                        ))}
                      {effectivePortfolioId && version.definition && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="ml-auto text-xs"
                          disabled={evaluate.isPending}
                          onClick={() =>
                            evaluate.mutate({
                              versionId: version.id,
                              dryRun: version.stage !== 'LIVE',
                            })
                          }
                        >
                          <FlaskConical className="mr-1 h-3.5 w-3.5" aria-hidden />
                          {version.stage === 'LIVE' ? 'Evaluate now' : 'Dry run'}
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          {evaluation && <EvaluationPanel evaluation={evaluation} />}

          {canWrite && (
            <BuilderCard
              strategies={list}
              watchlists={watchlists?.watchlists ?? []}
              onError={setError}
              onSaved={(strategyId) => {
                setSelectedId(strategyId);
                void queryClient.invalidateQueries({ queryKey: ['strategies'] });
              }}
            />
          )}
        </div>
      </div>
    </main>
  );
}

/** The stages a version may move to next. Mirrors the shared stage machine. */
function nextStages(stage: string): string[] {
  switch (stage) {
    case 'DRAFT':
      return ['BACKTEST', 'RETIRED'];
    case 'BACKTEST':
      return ['PAPER', 'RETIRED'];
    case 'PAPER':
      return ['REVIEW', 'RETIRED'];
    case 'REVIEW':
      return ['APPROVED', 'RETIRED'];
    case 'APPROVED':
      return ['LIVE', 'RETIRED'];
    case 'LIVE':
      return ['RETIRED'];
    default:
      return [];
  }
}

function StageLadder({ stage }: { stage: string }) {
  if (stage === 'RETIRED') {
    return <Badge className="border-border text-muted-foreground">retired</Badge>;
  }

  const reached = LADDER.indexOf(stage as (typeof LADDER)[number]);
  return (
    <span className="flex items-center gap-1" aria-label={`Stage ${stage}`}>
      {LADDER.map((rung, index) => (
        <span
          key={rung}
          className={cn(
            'rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide',
            index === reached && 'bg-sky-500/20 text-sky-300',
            index < reached && 'text-muted-foreground',
            index > reached && 'text-muted-foreground/40',
          )}
        >
          {rung}
        </span>
      ))}
    </span>
  );
}

function EvaluationPanel({ evaluation }: { evaluation: StrategyEvaluation }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          Evaluation · {evaluation.created.length} signal
          {evaluation.created.length === 1 ? '' : 's'}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-xs">
        <p className="text-muted-foreground">
          v{evaluation.version} on {evaluation.timeframe} at{' '}
          {formatDateTime(evaluation.evaluatedAt)} · correlation {evaluation.correlationId}
        </p>

        {evaluation.created.length > 0 && (
          <p>
            <span className="text-muted-foreground">fired </span>
            {evaluation.created.map((signal) => `${signal.symbol} ${signal.direction}`).join(', ')}
          </p>
        )}
        {evaluation.duplicates.length > 0 && (
          <p className="text-muted-foreground">
            already signalled on this bar: {evaluation.duplicates.join(', ')}
          </p>
        )}
        {evaluation.rejected.length > 0 && (
          <p className="text-muted-foreground">rule said no: {evaluation.rejected.join(', ')}</p>
        )}

        {evaluation.notEvaluable.length > 0 && (
          <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-2">
            <p className="font-medium text-amber-300">Could not be judged</p>
            <ul className="mt-1 space-y-0.5 text-muted-foreground">
              {evaluation.notEvaluable.map((skip) => (
                <li key={skip.symbol}>
                  <span className="text-foreground">{skip.symbol}</span> — {skip.reason}
                </li>
              ))}
            </ul>
            <p className="mt-1 text-[11px] text-muted-foreground">
              Unknown is not the same as no. These symbols were never asked the question, so they
              are named rather than dropped.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

const emptyRule = (): RuleNode => ({
  type: 'all',
  children: [{ type: 'condition', field: 'rsi14', operator: 'lt', operand: { constant: '30' } }],
});

interface BuilderProps {
  strategies: Strategy[];
  watchlists: Watchlist[];
  onError: (message: string | null) => void;
  onSaved: (strategyId: string) => void;
}

function BuilderCard({ strategies, watchlists, onError, onSaved }: BuilderProps) {
  const [target, setTarget] = useState('new');
  const [name, setName] = useState('');
  const [changeDescription, setChangeDescription] = useState('');
  const [timeframe, setTimeframe] = useState<(typeof TIMEFRAMES)[number]>('5m');
  const [watchlistId, setWatchlistId] = useState('');
  const [direction, setDirection] = useState<'LONG' | 'SHORT'>('LONG');
  const [entry, setEntry] = useState<RuleNode>(emptyRule);
  const [exit, setExit] = useState<RuleNode | null>(null);
  const [stopKind, setStopKind] = useState<'PERCENT' | 'ATR'>('PERCENT');
  const [stopValue, setStopValue] = useState('2');
  const [targetKind, setTargetKind] = useState<'PERCENT' | 'ATR' | 'RISK_MULTIPLE'>(
    'RISK_MULTIPLE',
  );
  const [targetValue, setTargetValue] = useState('2');
  const [maxConcurrentPositions, setMaxConcurrentPositions] = useState('3');
  const [maxNotionalPerTrade, setMaxNotionalPerTrade] = useState('10000');
  const [minBars, setMinBars] = useState('60');

  const definition = (): StrategyDefinition => ({
    timeframe,
    watchlistId: watchlistId || null,
    entry: { direction, when: entry },
    exit: exit ? { when: exit } : null,
    stop: stopValue.trim() ? { kind: stopKind, value: stopValue.trim() } : null,
    target: targetValue.trim() ? { kind: targetKind, value: targetValue.trim() } : null,
  });

  const riskSettings = (): StrategyRiskSettings => ({
    maxConcurrentPositions: Number(maxConcurrentPositions),
    maxNotionalPerTrade: maxNotionalPerTrade.trim(),
    minBars: Number(minBars),
  });

  const save = useMutation({
    mutationFn: async () => {
      if (target === 'new') {
        return api<Strategy>('/api/strategies', {
          method: 'POST',
          body: {
            name: name.trim(),
            definition: definition(),
            riskSettings: riskSettings(),
            changeDescription: changeDescription.trim(),
          },
        }).then((strategy) => strategy.id);
      }
      await api<StrategyVersion>(`/api/strategies/${target}/versions`, {
        method: 'POST',
        body: {
          definition: definition(),
          riskSettings: riskSettings(),
          changeDescription: changeDescription.trim(),
        },
      });
      return target;
    },
    onSuccess: (strategyId) => {
      onError(null);
      setChangeDescription('');
      onSaved(strategyId);
    },
    onError: (err: Error) => onError(explainApiError(err)),
  });

  const selectClass = 'rounded-md border border-input bg-background px-2 py-1 text-xs';

  return (
    <Card>
      <CardHeader>
        <CardTitle>Build a version</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-xs text-muted-foreground" htmlFor="builder-target">
            Save as
          </label>
          <select
            id="builder-target"
            className={selectClass}
            value={target}
            onChange={(e) => setTarget(e.target.value)}
          >
            <option value="new">a new strategy</option>
            {strategies
              .filter((strategy) => !strategy.isArchived)
              .map((strategy) => (
                <option key={strategy.id} value={strategy.id}>
                  a new version of {strategy.name}
                </option>
              ))}
          </select>

          {target === 'new' && (
            <Input
              className="h-8 max-w-52 text-xs"
              placeholder="Strategy name"
              aria-label="Strategy name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <select
            className={selectClass}
            aria-label="Timeframe"
            value={timeframe}
            onChange={(e) => setTimeframe(e.target.value as (typeof TIMEFRAMES)[number])}
          >
            {TIMEFRAMES.map((tf) => (
              <option key={tf} value={tf}>
                {tf} bars
              </option>
            ))}
          </select>

          <select
            className={selectClass}
            aria-label="Universe"
            value={watchlistId}
            onChange={(e) => setWatchlistId(e.target.value)}
          >
            <option value="">Every instrument</option>
            {watchlists.map((watchlist) => (
              <option key={watchlist.id} value={watchlist.id}>
                {watchlist.name} ({watchlist.symbols.length})
              </option>
            ))}
          </select>

          <select
            className={selectClass}
            aria-label="Direction"
            value={direction}
            onChange={(e) => setDirection(e.target.value as 'LONG' | 'SHORT')}
          >
            <option value="LONG">go long</option>
            <option value="SHORT">go short</option>
          </select>
        </div>

        <section className="space-y-1.5">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Entry rule
          </h3>
          <RuleTreeEditor node={entry} onChange={setEntry} labelPrefix="entry" />
        </section>

        <section className="space-y-1.5">
          <div className="flex items-center gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Exit rule
            </h3>
            <button
              type="button"
              className={selectClass}
              onClick={() => setExit(exit ? null : emptyRule())}
            >
              {exit ? 'Remove exit rule' : 'Add exit rule'}
            </button>
          </div>
          {exit ? (
            <RuleTreeEditor node={exit} onChange={setExit} labelPrefix="exit" />
          ) : (
            <p className="text-[11px] text-muted-foreground">
              Without one, positions leave on the stop or the target only.
            </p>
          )}
        </section>

        <section className="flex flex-wrap items-end gap-3 border-t border-border pt-3">
          <Field label="Stop">
            <select
              className={selectClass}
              aria-label="Stop kind"
              value={stopKind}
              onChange={(e) => setStopKind(e.target.value as 'PERCENT' | 'ATR')}
            >
              <option value="PERCENT">percent</option>
              <option value="ATR">× ATR</option>
            </select>
            <Input
              className="h-8 w-20 text-xs tabular-nums"
              aria-label="Stop value"
              inputMode="decimal"
              value={stopValue}
              onChange={(e) => setStopValue(e.target.value)}
            />
          </Field>

          <Field label="Target">
            <select
              className={selectClass}
              aria-label="Target kind"
              value={targetKind}
              onChange={(e) => setTargetKind(e.target.value as 'PERCENT' | 'ATR' | 'RISK_MULTIPLE')}
            >
              <option value="RISK_MULTIPLE">× risk</option>
              <option value="PERCENT">percent</option>
              <option value="ATR">× ATR</option>
            </select>
            <Input
              className="h-8 w-20 text-xs tabular-nums"
              aria-label="Target value"
              inputMode="decimal"
              value={targetValue}
              onChange={(e) => setTargetValue(e.target.value)}
            />
          </Field>
        </section>

        <p className="text-[11px] text-muted-foreground">
          A version with no stop can be drafted and backtested, but cannot be approved. Trading
          without a stop is a bet, not a strategy.
        </p>

        <section className="flex flex-wrap items-end gap-3 border-t border-border pt-3">
          <Field label="Max positions">
            <Input
              className="h-8 w-16 text-xs tabular-nums"
              aria-label="Max concurrent positions"
              inputMode="numeric"
              value={maxConcurrentPositions}
              onChange={(e) => setMaxConcurrentPositions(e.target.value)}
            />
          </Field>
          <Field label="Max per trade">
            <Input
              className="h-8 w-24 text-xs tabular-nums"
              aria-label="Max notional per trade"
              inputMode="decimal"
              value={maxNotionalPerTrade}
              onChange={(e) => setMaxNotionalPerTrade(e.target.value)}
            />
          </Field>
          <Field label="Min bars">
            <Input
              className="h-8 w-16 text-xs tabular-nums"
              aria-label="Minimum bars"
              inputMode="numeric"
              value={minBars}
              onChange={(e) => setMinBars(e.target.value)}
            />
          </Field>
        </section>

        <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
          <Input
            className="h-8 min-w-52 flex-1 text-xs"
            placeholder="What changed, and why (at least eight characters)"
            aria-label="Change description"
            value={changeDescription}
            onChange={(e) => setChangeDescription(e.target.value)}
          />
          <Button
            size="sm"
            disabled={save.isPending || (target === 'new' && !name.trim())}
            onClick={() => save.mutate()}
          >
            <Plus className="mr-1 h-3.5 w-3.5" aria-hidden />
            {save.isPending ? 'Saving…' : 'Save as draft'}
          </Button>
        </div>
        <p className="text-[11px] text-muted-foreground">
          Saving creates a draft. Nothing runs until someone walks it up the ladder, and going live
          is a separate step from being approved.
        </p>
      </CardContent>
    </Card>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <span className="block text-[11px] text-muted-foreground">{label}</span>
      <div className="flex items-center gap-1.5">{children}</div>
    </div>
  );
}
