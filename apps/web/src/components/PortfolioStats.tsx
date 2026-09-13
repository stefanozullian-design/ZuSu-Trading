import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ObjectiveBadge } from '@/components/Owners';
import { formatMoney, formatPercent, formatSignedMoney, pnlTone } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { PortfolioSummary } from '@/lib/types';

interface StatProps {
  label: string;
  value: string;
  tone?: string;
  hint?: string;
}

function Stat({ label, value, tone, hint }: StatProps) {
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

/**
 * The numbers a trader checks first, in the order they check them (§45, §73).
 * A value the backend could not compute renders as an em dash — never as zero.
 */
export function PortfolioStats({ portfolio }: { portfolio: PortfolioSummary }) {
  const riskUsed = portfolio.dailyRiskUsedPct;
  const riskNumber = riskUsed === null ? null : Number(riskUsed);
  const riskTone =
    riskNumber === null
      ? 'text-muted-foreground'
      : riskNumber >= 80
        ? 'text-loss'
        : riskNumber >= 50
          ? 'text-amber-400'
          : 'text-foreground';

  return (
    <Card>
      <CardContent className="grid grid-cols-2 gap-4 pt-4 sm:grid-cols-3 lg:grid-cols-5">
        <Stat
          label="Daily P&L"
          value={formatSignedMoney(portfolio.dailyPnl, portfolio.baseCurrency)}
          tone={pnlTone(portfolio.dailyPnl)}
          hint={
            portfolio.dailyPnl === null
              ? 'no prior snapshot to compare against'
              : formatPercent(portfolio.dailyPnlPct)
          }
        />
        <Stat
          label="Account value"
          value={formatMoney(portfolio.equity, portfolio.baseCurrency)}
          hint={
            portfolio.equity === null
              ? 'positions are unmarked'
              : `from ${formatMoney(portfolio.initialCapital, portfolio.baseCurrency)}`
          }
        />
        <Stat
          label="Cash"
          value={formatMoney(portfolio.cashBalance, portfolio.baseCurrency)}
          hint={`${portfolio.openPositions} open position${portfolio.openPositions === 1 ? '' : 's'}`}
        />
        <Stat
          label="Positions value"
          value={formatMoney(portfolio.positionsValue, portfolio.baseCurrency)}
        />
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Daily risk used
          </p>
          <p className={cn('text-xl font-semibold tabular sm:text-2xl', riskTone)}>
            {riskUsed === null ? '—' : `${riskNumber?.toFixed(0)}%`}
          </p>
          <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div
              className={cn(
                'h-full rounded-full transition-all',
                riskNumber !== null && riskNumber >= 80
                  ? 'bg-loss'
                  : riskNumber !== null && riskNumber >= 50
                    ? 'bg-amber-500'
                    : 'bg-primary',
              )}
              style={{ width: `${Math.min(100, riskNumber ?? 0)}%` }}
            />
          </div>
          <p className="mt-1 text-[11px] text-muted-foreground">of the daily loss limit</p>
        </div>
      </CardContent>
      <div className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-2 text-xs">
        <Badge variant={portfolio.tradingState === 'ACTIVE' ? 'success' : 'danger'}>
          {portfolio.tradingState.replace('_', ' ')}
        </Badge>
        <Badge variant="neutral">{portfolio.executionMode.replace('_', ' ')}</Badge>
        {portfolio.clientName && <Badge variant="outline">{portfolio.clientName}</Badge>}
        {/*
          What the money is for, beside whose it is. Rendered as a dash when
          nobody has said, rather than defaulted to something plausible — the
          same rule every other unknown on this page follows.
        */}
        <Badge variant="outline">
          <ObjectiveBadge objective={portfolio.objective} />
        </Badge>
      </div>
    </Card>
  );
}
