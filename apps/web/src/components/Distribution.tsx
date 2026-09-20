import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';

/**
 * Ranked bars: how the money is spread.
 *
 * One series, so one hue — the category names are on the axis and colour is
 * not carrying identity. Giving each sector its own colour would be a
 * categorical palette doing a job the labels already do, and would leave the
 * reader matching swatches to find the biggest slice.
 *
 * Not a pie, for the usual reason: the question is "is anything too big", and
 * people compare lengths accurately and angles badly. Ranked bars also let the
 * limit be drawn where it actually falls.
 *
 * The limit marker is the point of the chart. A weight is not interesting on
 * its own — 18% in one sector is prudent for one portfolio and a breach for
 * another — so the bar is drawn against the line it must not cross.
 */

export interface Slice {
  key: string;
  /** Percent of equity. Null when something could not be priced. */
  pct: string | null;
  value: string;
  /** What the portfolio's objective allows, if anything. */
  limitPct?: number;
}

export function Distribution({
  title,
  slices,
  empty,
  unpriced,
}: {
  title: string;
  slices: Slice[];
  empty: string;
  unpriced: string[];
}) {
  // Scaled to whichever is larger, the biggest slice or the limit — never to
  // 100%, which at these weights would render every bar as a stub and hide the
  // comparison this chart exists for.
  //
  // Including the limit in the scale is what makes the marker mean anything.
  // Scaling to the largest slice alone pins the limit line to the right-hand
  // edge whenever nothing breaches, where it reads as a border rather than as
  // the threshold everything is comfortably inside.
  const largestSlice = slices.reduce((max, s) => Math.max(max, Number(s.pct ?? 0)), 0);
  const largestLimit = slices.reduce((max, s) => Math.max(max, s.limitPct ?? 0), 0);
  const axis = Math.max(largestSlice, largestLimit);
  const scale = (pct: number) => (axis === 0 ? 0 : Math.max((pct / axis) * 100, 1.5));

  return (
    // A labelled region, so a screen reader can jump to "By sector" directly
    // and a test can address the panel rather than guessing at a wrapper div.
    <Card role="region" aria-label={title}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2.5">
        {slices.length === 0 && <p className="text-sm text-muted-foreground">{empty}</p>}

        {unpriced.length > 0 && slices.length > 0 && (
          <p className="text-[11px] text-amber-300">
            Percentages are withheld: {unpriced.join(', ')} cannot be priced, so every weight here
            would be measured against an incomplete total.
          </p>
        )}

        {slices.map((slice) => {
          const pct = slice.pct === null ? null : Number(slice.pct);
          const over = pct !== null && slice.limitPct !== undefined && pct > slice.limitPct;
          return (
            <div key={slice.key} className="space-y-1">
              <div className="flex items-baseline justify-between gap-2 text-xs">
                <span className="truncate font-medium">{slice.key}</span>
                {/* Text wears text tokens; the bar beside it carries the state. */}
                <span className={cn('tabular', over ? 'text-loss' : 'text-muted-foreground')}>
                  {pct === null ? '—' : `${pct.toFixed(1)}%`}
                </span>
              </div>
              <div
                className="relative h-2.5 w-full rounded-sm bg-muted"
                role="img"
                aria-label={
                  pct === null
                    ? `${slice.key}, weight unknown`
                    : `${slice.key}, ${pct.toFixed(1)} percent` +
                      (slice.limitPct === undefined
                        ? ''
                        : ` of a ${String(slice.limitPct)} percent limit`)
                }
              >
                {pct !== null && (
                  <div
                    className={cn(
                      // Square at the baseline, rounded at the data end.
                      'absolute inset-y-0 left-0 rounded-r-sm',
                      over ? 'bg-loss' : 'bg-primary',
                    )}
                    style={{ width: `${String(scale(pct))}%` }}
                  />
                )}
                {slice.limitPct !== undefined && axis > 0 && (
                  <div
                    className="absolute inset-y-[-3px] w-px bg-muted-foreground"
                    style={{ left: `${String(Math.min(scale(slice.limitPct), 100))}%` }}
                    title={`Limit for this objective: ${String(slice.limitPct)}%`}
                  />
                )}
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
