import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatMoney } from '@/lib/format';
import type { CompositionDto } from '@/lib/types';

/**
 * How spread out the money actually is.
 *
 * Three figures rather than a chart, because each is a single current value
 * and a one-bar bar chart is not a chart.
 *
 * The lead figure is the one nobody computes by hand. Six holdings with one of
 * them at seventy percent is not six holdings, and the count on its own says
 * it is — so what is shown is the number of *equally sized* holdings the
 * portfolio behaves like. It is the reciprocal of the Herfindahl index, which
 * is named in the caption so the number can be checked rather than believed.
 */
export function Concentration({ composition }: { composition: CompositionDto }) {
  const { concentration, holdings } = composition;
  const names = concentration.effectiveNames;

  return (
    <Card role="region" aria-label="Concentration">
      <CardHeader>
        <CardTitle>Concentration</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div>
          <p className="text-3xl font-semibold tabular">
            {names === null ? '—' : Number(names).toFixed(1)}
          </p>
          <p className="text-[11px] text-muted-foreground">
            {names === null
              ? 'Not measurable yet — nothing is invested, or something cannot be priced.'
              : `Effective holdings. You hold ${String(holdings.length)}; by weight it behaves like this many equally sized ones. (1 ÷ Herfindahl index, currently ${Number(concentration.herfindahl ?? 0).toFixed(3)}.)`}
          </p>
        </div>

        <dl className="grid grid-cols-2 gap-3 border-t border-border pt-3 text-xs">
          <div>
            <dt className="text-muted-foreground">Largest holding</dt>
            <dd className="tabular">
              {concentration.largest === null ? (
                '—'
              ) : (
                <>
                  <span className="font-mono font-medium">{concentration.largest.key}</span>{' '}
                  {concentration.largest.pct === null
                    ? formatMoney(concentration.largest.value)
                    : `${Number(concentration.largest.pct).toFixed(1)}%`}
                </>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Top three</dt>
            <dd className="tabular">
              {concentration.topThreePct === null
                ? '—'
                : `${Number(concentration.topThreePct).toFixed(1)}%`}
            </dd>
          </div>
        </dl>
      </CardContent>
    </Card>
  );
}
