import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, CircleHelp, Gauge, X } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { api, explainApiError } from '@/lib/api';
import { cn } from '@/lib/utils';
import type { AutomationConfig, ExecutionModeName, ReadinessReport } from '@/lib/types';

/**
 * Automation.
 *
 * The page where a person decides whether a recommendation may become an order
 * without them. Three things it deliberately does:
 *
 *   - **Shows all eight conditions, always** — passing ones too. A checklist
 *     that only lists failures cannot tell you whether it ran.
 *   - **Renders "could not check" as its own thing**, never folded in with a
 *     pass. Unknown is not permission, and the page has to say so in a colour
 *     nobody mistakes for green.
 *   - **Makes raising harder than lowering.** Raising needs a typed phrase;
 *     lowering is one button that is never disabled.
 */

const LADDER: ExecutionModeName[] = ['OBSERVE', 'MANUAL_APPROVAL', 'LIMITED_AUTO', 'FULL_AUTO'];

const MODE_COPY: Record<ExecutionModeName, string> = {
  OBSERVE: 'Recommendations are recorded and nothing is ever sent to a broker.',
  MANUAL_APPROVAL: 'Every order waits for a person to approve it. This is the default.',
  LIMITED_AUTO:
    'Orders are placed without a click, under caps: at most 3 a day and 2,500 per order. ' +
    'The rung exists to be watched.',
  FULL_AUTO: 'Orders are placed within the risk engine’s limits, with no per-order cap.',
};

export function AutomationPage() {
  const [selected, setSelected] = useState<string | null>(null);

  const { data: configs } = useQuery({
    queryKey: ['automation-configs'],
    queryFn: () => api<AutomationConfig[]>('/api/automation/configs'),
  });

  const activeId = selected ?? configs?.[0]?.configId ?? null;

  return (
    <main className="mx-auto w-full max-w-7xl space-y-3 px-3 py-4 sm:px-6">
      <Card>
        <CardHeader className="flex-row items-center gap-2">
          <Gauge className="h-3.5 w-3.5 text-sky-400" aria-hidden />
          <CardTitle>Automation</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-xs">
          <p className="text-muted-foreground">
            Every strategy running against a portfolio sits on one rung of this ladder. Raising it
            is a person’s act, one rung at a time, against eight conditions that are re-checked
            before every automatic order. Lowering it is one button and is never refused.
          </p>
          {(configs ?? []).length === 0 && (
            <p className="text-muted-foreground">
              No strategy is configured against a portfolio yet, so there is nothing to automate.
            </p>
          )}
          <div className="flex flex-wrap gap-1.5">
            {(configs ?? []).map((config) => (
              <button
                key={config.configId}
                type="button"
                onClick={() => setSelected(config.configId)}
                className={cn(
                  'rounded-md border px-2 py-1 text-left text-[11px]',
                  config.configId === activeId
                    ? 'border-sky-500/50 bg-sky-500/10'
                    : 'border-border hover:border-sky-500/30',
                )}
              >
                <span className="block font-medium">
                  {config.strategyName} v{config.version}
                </span>
                <span className="block text-muted-foreground">
                  {config.portfolioName} · {config.environment} · {config.mode}
                </span>
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      {activeId && <ConfigPanel configId={activeId} />}
    </main>
  );
}

function ConfigPanel({ configId }: { configId: string }) {
  const queryClient = useQueryClient();
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState<string | null>(null);

  const { data: readiness } = useQuery({
    queryKey: ['automation-readiness', configId],
    queryFn: () => api<ReadinessReport>(`/api/automation/configs/${configId}/readiness`),
  });

  const change = useMutation({
    mutationFn: (input: { mode: ExecutionModeName; confirmation?: string }) =>
      api<{ detail: string }>(`/api/automation/configs/${configId}/mode`, {
        method: 'POST',
        body: input,
      }),
    onSuccess: async () => {
      setError(null);
      setConfirmation('');
      await queryClient.invalidateQueries({ queryKey: ['automation-configs'] });
      await queryClient.invalidateQueries({ queryKey: ['automation-readiness', configId] });
    },
    onError: (err: Error) => setError(explainApiError(err)),
  });

  if (!readiness) return null;

  const current = readiness.currentMode;
  const next = readiness.nextMode;
  const lower = LADDER.slice(0, LADDER.indexOf(current));

  return (
    <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_340px]">
      <Card>
        <CardHeader className="flex-row items-center justify-between gap-2">
          <CardTitle>The eight conditions</CardTitle>
          <Badge
            className={cn(
              readiness.ready
                ? 'border-emerald-500/40 text-emerald-400'
                : 'border-amber-500/40 text-amber-400',
            )}
          >
            {readiness.ready ? 'ALL MET' : 'NOT MET'}
          </Badge>
        </CardHeader>
        <CardContent className="space-y-1.5 text-xs">
          {readiness.checks.map((check) => (
            <div key={check.key} className="flex gap-2 rounded-md border border-border p-2">
              <StateIcon state={check.state} />
              <div className="min-w-0">
                <p className="font-medium">{check.label}</p>
                <p className="text-[11px] text-muted-foreground">{check.detail}</p>
              </div>
            </div>
          ))}
          <p className="pt-1 text-[11px] text-muted-foreground">{readiness.summary}</p>
        </CardContent>
      </Card>

      <div className="space-y-3">
        <Card>
          <CardHeader>
            <CardTitle>Currently: {current}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-xs">
            <p className="text-muted-foreground">{MODE_COPY[current]}</p>

            {error && (
              <p className="rounded-md border border-red-500/30 bg-red-500/5 p-2 text-[11px] text-red-400">
                {error}
              </p>
            )}
            {change.data && (
              <p className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-2 text-[11px] text-emerald-300">
                {change.data.detail}
              </p>
            )}

            {next ? (
              <div className="space-y-1.5 rounded-md border border-border p-2">
                <p className="font-medium">Raise to {next}</p>
                <p className="text-[11px] text-muted-foreground">{MODE_COPY[next]}</p>
                <Input
                  className="h-8 text-xs"
                  aria-label="Confirmation phrase"
                  placeholder={`I authorise ${next}`}
                  value={confirmation}
                  onChange={(e) => setConfirmation(e.target.value)}
                />
                <Button
                  size="sm"
                  className="w-full"
                  disabled={!readiness.ready || change.isPending}
                  onClick={() => change.mutate({ mode: next, confirmation })}
                >
                  Authorise {next}
                </Button>
                {!readiness.ready && (
                  <p className="text-[11px] text-amber-400">
                    Not while a condition is unmet. None of the eight is waived here.
                  </p>
                )}
              </div>
            ) : (
              <p className="text-[11px] text-muted-foreground">
                This is the top of the ladder. There is nothing above it to raise to.
              </p>
            )}

            {lower.length > 0 && (
              <div className="space-y-1.5 rounded-md border border-border p-2">
                <p className="font-medium">Lower it</p>
                <p className="text-[11px] text-muted-foreground">
                  Never refused, never gated on a check, and it clears the authority — raising it
                  again is a fresh signature.
                </p>
                {lower.reverse().map((mode) => (
                  <Button
                    key={mode}
                    size="sm"
                    variant="outline"
                    className="w-full"
                    onClick={() => change.mutate({ mode })}
                  >
                    Lower to {mode}
                  </Button>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function StateIcon({ state }: { state: ReadinessReport['checks'][number]['state'] }) {
  if (state === 'PASS') {
    return <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-400" aria-label="met" />;
  }
  if (state === 'FAIL') {
    return <X className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-400" aria-label="not met" />;
  }
  // Its own colour and its own icon. Folding it in with a pass is the failure
  // this whole gate exists to prevent.
  return (
    <CircleHelp
      className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400"
      aria-label="could not be checked"
    />
  );
}
