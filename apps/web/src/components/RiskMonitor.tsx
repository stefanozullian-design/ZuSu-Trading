import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, ShieldAlert, TriangleAlert } from 'lucide-react';
import { api } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatMoney } from '@/lib/format';
import type { GateDecision, RiskLimits } from '@/lib/types';

export function RiskMonitor({ portfolioId }: { portfolioId: string }) {
  const gate = useQuery({
    queryKey: ['gate', portfolioId],
    queryFn: () => api<GateDecision>(`/api/risk/portfolios/${portfolioId}/gate`),
    refetchInterval: 15_000,
  });
  const limits = useQuery({
    queryKey: ['limits', portfolioId],
    queryFn: () => api<RiskLimits>(`/api/risk/portfolios/${portfolioId}/limits`),
  });

  const decision = gate.data;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Risk monitor</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          {gate.isLoading && <p className="text-sm text-muted-foreground">Evaluating…</p>}
          {decision && (
            <div className="flex items-start gap-2">
              {decision.allowed ? (
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" aria-hidden />
              ) : (
                <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-red-400" aria-hidden />
              )}
              <div className="min-w-0">
                <p className="text-sm font-medium">
                  {decision.allowed ? 'Trading permitted' : 'Trading blocked'}
                </p>
                {decision.blockers.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    No blocking conditions. Portfolio-level limits join this check in Phase 7.
                  </p>
                ) : (
                  <ul className="mt-1 space-y-1">
                    {decision.blockers.map((blocker) => (
                      <li key={blocker.code} className="flex items-start gap-1.5 text-xs">
                        <TriangleAlert
                          className={
                            blocker.severity === 'BLOCKING'
                              ? 'mt-0.5 h-3 w-3 shrink-0 text-red-400'
                              : 'mt-0.5 h-3 w-3 shrink-0 text-amber-400'
                          }
                          aria-hidden
                        />
                        <span
                          className={
                            blocker.severity === 'BLOCKING' ? 'text-red-300' : 'text-amber-300'
                          }
                        >
                          {blocker.message}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}
        </div>

        {limits.data && (
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 border-t border-border pt-3 text-xs">
            <Limit label="Max daily loss" value={formatMoney(limits.data.maxDailyLoss)} />
            <Limit label="Max weekly loss" value={formatMoney(limits.data.maxWeeklyLoss)} />
            <Limit label="Max position size" value={formatMoney(limits.data.maxPositionSize)} />
            <Limit label="Max open positions" value={String(limits.data.maxOpenPositions)} />
            <Limit label="Max trades / day" value={String(limits.data.maxTradesPerDay)} />
            <Limit
              label="Max drawdown"
              value={`${Number(limits.data.maxDrawdownPct).toFixed(0)}%`}
            />
          </dl>
        )}
      </CardContent>
    </Card>
  );
}

function Limit({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="truncate text-muted-foreground">{label}</dt>
      <dd className="font-medium tabular">{value}</dd>
    </div>
  );
}
