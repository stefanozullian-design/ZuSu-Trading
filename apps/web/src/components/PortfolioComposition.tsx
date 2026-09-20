import { useQuery } from '@tanstack/react-query';
import { type PortfolioObjective, riskProfileFor } from '@zusu/shared';
import { Concentration } from '@/components/Concentration';
import { Distribution, type Slice } from '@/components/Distribution';
import { Findings } from '@/components/Findings';
import { api } from '@/lib/api';
import type { CompositionDto } from '@/lib/types';

/**
 * The composition block: findings, spread, concentration.
 *
 * One query feeding all three panels, deliberately. Every percentage on screen
 * divides by the same equity, and assembling these from separate requests
 * would let a sector weight and a holding weight be computed against
 * valuations taken seconds apart — a discrepancy nobody would spot and nobody
 * could explain.
 */
export function PortfolioComposition({
  portfolioId,
  objective,
}: {
  portfolioId: string;
  objective: PortfolioObjective | null;
}) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['composition', portfolioId],
    queryFn: () => api<CompositionDto>(`/api/portfolios/${portfolioId}/composition`),
    refetchInterval: 60_000,
  });

  if (isLoading) return <p className="text-sm text-muted-foreground">Reading the portfolio…</p>;
  if (error || !data) {
    return <p className="text-sm text-loss">Could not read what this portfolio is made of.</p>;
  }

  // riskProfileFor, not a conditional lookup. A portfolio with no objective
  // stated still gets judged — the server falls back to the widest profile and
  // raises findings against it — so a screen that showed no limit line for the
  // same portfolio would contradict the breach printed directly above it.
  const profile = riskProfileFor(objective);

  const sectors: Slice[] = data.bySector.map((weight) => ({
    key: weight.key,
    pct: weight.pct,
    value: weight.value,
    // Unclassified is a bucket, not a sector, so it gets no limit line: a
    // marker there would assert a rule about a group that is only a group
    // because nobody recorded what its members are.
    ...(profile && weight.key !== 'Unclassified' ? { limitPct: profile.maxSectorExposurePct } : {}),
  }));

  const holdings: Slice[] = data.bySymbol.map((weight) => ({
    key: weight.key,
    pct: weight.pct,
    value: weight.value,
    limitPct: profile.maxSymbolExposurePct,
  }));

  return (
    <>
      <Findings findings={data.findings} />
      <div className="grid gap-4 md:grid-cols-2">
        <Distribution
          title="By holding"
          slices={holdings}
          unpriced={data.unpriced}
          empty="Nothing is held yet. Record a buy on the Holdings page and it appears here."
        />
        <Distribution
          title="By sector"
          slices={sectors}
          unpriced={data.unpriced}
          empty="Nothing is held yet, so there is nothing to spread across sectors."
        />
      </div>
      <Concentration composition={data} />
    </>
  );
}
