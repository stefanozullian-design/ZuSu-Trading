import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, explainApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { RiskLimits } from '@/lib/types';

/**
 * Changing the numbers that will one day stop a loss.
 *
 * Administrator-only, and deliberately: a trading account that can raise its
 * own limits has limits in name only. The separation costs a second sign-in on
 * a one-person installation, and that friction is the point — it sits between
 * "this refusal is annoying" and "I raised the limit".
 *
 * A reason is required for the same purpose a rejection needs one: the numbers
 * are easy to read afterwards and impossible to interpret without knowing why
 * they moved. Each change writes a new version, so the limits that were in
 * force when something was refused stay readable after the next change.
 */
export function EditRiskLimits({
  portfolioId,
  limits,
  onDone,
}: {
  portfolioId: string;
  limits: RiskLimits;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState({
    maxDailyLoss: limits.maxDailyLoss,
    maxWeeklyLoss: limits.maxWeeklyLoss,
    maxPositionSize: limits.maxPositionSize,
    maxPortfolioExposurePct: limits.maxPortfolioExposurePct,
    maxSectorExposurePct: limits.maxSectorExposurePct,
    maxSymbolExposurePct: limits.maxSymbolExposurePct,
    maxOpenPositions: String(limits.maxOpenPositions),
    maxTradesPerDay: String(limits.maxTradesPerDay),
    maxConsecutiveLosses: String(limits.maxConsecutiveLosses),
    maxDrawdownPct: limits.maxDrawdownPct,
  });
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () =>
      api<RiskLimits>(`/api/risk/portfolios/${portfolioId}/limits`, {
        method: 'PUT',
        body: {
          ...draft,
          maxOpenPositions: Number(draft.maxOpenPositions),
          maxTradesPerDay: Number(draft.maxTradesPerDay),
          maxConsecutiveLosses: Number(draft.maxConsecutiveLosses),
          reason: reason.trim(),
        },
      }),
    onSuccess: async () => {
      setError(null);
      await queryClient.invalidateQueries({ queryKey: ['risk-limits'] });
      await queryClient.invalidateQueries({ queryKey: ['risk'] });
      onDone();
    },
    onError: (err: Error) => setError(explainApiError(err)),
  });

  const field = (label: string, key: keyof typeof draft, hint?: string) => (
    <label className="block space-y-1">
      <span className="block text-[10px] uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <Input
        id={`limit-${key}`}
        className="h-8 text-xs tabular-nums"
        aria-label={label}
        inputMode="decimal"
        value={draft[key]}
        onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
      />
      {hint && <span className="block text-[10px] text-muted-foreground">{hint}</span>}
    </label>
  );

  return (
    <div className="space-y-2 border-t border-border pt-3 text-xs">
      <div className="grid gap-2 sm:grid-cols-2">
        {field('Max daily loss', 'maxDailyLoss', 'currency')}
        {field('Max weekly loss', 'maxWeeklyLoss', 'currency')}
        {field('Max position size', 'maxPositionSize', 'currency')}
        {field('Max drawdown %', 'maxDrawdownPct')}
        {field('Portfolio exposure %', 'maxPortfolioExposurePct')}
        {field('Sector exposure %', 'maxSectorExposurePct')}
        {field('Symbol exposure %', 'maxSymbolExposurePct')}
        {field('Open positions', 'maxOpenPositions')}
        {field('Trades per day', 'maxTradesPerDay')}
        {field('Consecutive losses', 'maxConsecutiveLosses')}
      </div>

      <label className="block space-y-1">
        <span className="block text-[10px] uppercase tracking-wider text-muted-foreground">
          Why (recorded with the change)
        </span>
        <Input
          id="limit-reason"
          className="h-8 text-xs"
          aria-label="Reason for the change"
          placeholder="Holdings imported; limits were set for the opening cash"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </label>

      <p className="text-[11px] text-muted-foreground">
        This writes a new version. The current numbers, who set them and why are all kept — the
        limits in force when something was refused have to stay readable afterwards, or the refusal
        cannot be explained.
      </p>

      {error && (
        <p className="rounded-md border border-red-500/30 bg-red-500/5 p-2 text-[11px] text-red-400">
          {error}
        </p>
      )}

      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={reason.trim().length < 10 || save.isPending}
          onClick={() => save.mutate()}
        >
          {save.isPending ? 'Saving…' : 'Save new version'}
        </Button>
        <Button size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
