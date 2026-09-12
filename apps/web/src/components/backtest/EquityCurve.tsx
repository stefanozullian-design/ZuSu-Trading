import { useRef, useState } from 'react';
import {
  SERIES_COLORS,
  compact,
  extentOf,
  linePath,
  linearScale,
  padDomain,
  ticksFor,
  timeLabel,
} from '@/components/market/chart-primitives';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

const WIDTH = 640;
const HEIGHT = 220;
const PAD = { top: 12, right: 56, bottom: 18, left: 6 };

interface Props {
  points: { at: string; equity: string }[];
  initialCapital: string;
  timeframe: string;
}

/**
 * The equity curve, with the starting capital as a reference line.
 *
 * One axis, as everywhere else here. The starting capital is drawn rather than
 * stated because the only question a reader asks of this chart is "was it ever
 * under water", and a horizontal line answers it at a glance.
 *
 * The deepest drawdown is shaded, so the figure the metrics report has a place
 * on the chart instead of being a number to take on trust.
 */
export function EquityCurve({ points, initialCapital, timeframe }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);

  const values = points.map((point) => Number(point.equity));
  const start = Number(initialCapital);
  const domain = padDomain(extentOf(values, [start]));

  const plot = { x0: PAD.left, x1: WIDTH - PAD.right, y0: PAD.top, y1: HEIGHT - PAD.bottom };
  const x = linearScale([0, Math.max(points.length - 1, 1)], [plot.x0, plot.x1]);
  const y = linearScale(domain, [plot.y1, plot.y0]);
  const ticks = ticksFor(domain, 4);

  const trough = deepestTrough(values);

  function onMove(event: React.PointerEvent<SVGSVGElement>) {
    const svg = svgRef.current;
    if (!svg || points.length === 0) return;
    const rect = svg.getBoundingClientRect();
    const viewX = ((event.clientX - rect.left) / rect.width) * WIDTH;
    const ratio = (viewX - plot.x0) / (plot.x1 - plot.x0);
    const index = Math.round(ratio * (points.length - 1));
    setHover(Math.max(0, Math.min(points.length - 1, index)));
  }

  const hovered = hover === null ? null : points[hover];

  return (
    <Card>
      <CardHeader className="flex-row items-baseline justify-between gap-2">
        <CardTitle>Equity</CardTitle>
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
          {points.length} samples
        </span>
      </CardHeader>
      <CardContent>
        {points.length < 2 ? (
          <p className="py-12 text-center text-sm text-muted-foreground">
            Too few points to plot a curve.
          </p>
        ) : (
          <>
            <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <svg width="14" height="4" aria-hidden>
                  <rect width="14" height="3" rx="1.5" fill={SERIES_COLORS.price} />
                </svg>
                equity
              </span>
              <span className="flex items-center gap-1.5">
                <svg width="14" height="4" aria-hidden>
                  <rect width="14" height="1.5" y="1" fill="currentColor" opacity="0.5" />
                </svg>
                starting capital
              </span>
              {trough && (
                <span className="flex items-center gap-1.5">
                  <svg width="14" height="8" aria-hidden>
                    <rect width="14" height="8" rx="2" fill="#EF4444" opacity="0.18" />
                  </svg>
                  deepest drawdown
                </span>
              )}
            </div>

            <svg
              ref={svgRef}
              viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
              className="w-full touch-none"
              role="img"
              aria-label={`Equity over ${String(points.length)} samples, starting at ${initialCapital}`}
              onPointerMove={onMove}
              onPointerLeave={() => setHover(null)}
            >
              {ticks.map((tick) => (
                <g key={tick}>
                  <line
                    x1={plot.x0}
                    x2={plot.x1}
                    y1={y(tick)}
                    y2={y(tick)}
                    stroke="currentColor"
                    strokeOpacity="0.08"
                  />
                  <text
                    x={plot.x1 + 6}
                    y={y(tick) + 3}
                    className="fill-current text-[9px] opacity-45"
                  >
                    {compact(tick)}
                  </text>
                </g>
              ))}

              {trough && (
                <rect
                  x={x(trough.peakIndex)}
                  width={Math.max(1, x(trough.troughIndex) - x(trough.peakIndex))}
                  y={y(trough.peakValue)}
                  height={Math.max(1, y(trough.troughValue) - y(trough.peakValue))}
                  fill="#EF4444"
                  opacity="0.14"
                />
              )}

              <line
                x1={plot.x0}
                x2={plot.x1}
                y1={y(start)}
                y2={y(start)}
                stroke="currentColor"
                strokeOpacity="0.45"
                strokeDasharray="3 3"
              />

              <path
                d={linePath(values, x, y)}
                fill="none"
                stroke={SERIES_COLORS.price}
                strokeWidth="2"
                strokeLinejoin="round"
              />

              {hover !== null && hovered && (
                <>
                  <line
                    x1={x(hover)}
                    x2={x(hover)}
                    y1={plot.y0}
                    y2={plot.y1}
                    stroke="currentColor"
                    strokeOpacity="0.3"
                  />
                  <circle
                    cx={x(hover)}
                    cy={y(Number(hovered.equity))}
                    r="4"
                    fill={SERIES_COLORS.price}
                    stroke="var(--background, #0F1219)"
                    strokeWidth="2"
                  />
                </>
              )}
            </svg>

            <p className="mt-1 h-4 text-[11px] text-muted-foreground">
              {hovered ? (
                <>
                  {timeLabel(hovered.at, timeframe)} UTC ·{' '}
                  <span className="font-medium text-foreground tabular-nums">
                    {Number(hovered.equity).toLocaleString(undefined, {
                      maximumFractionDigits: 2,
                    })}
                  </span>
                </>
              ) : (
                'Hover for the equity at a point in the run.'
              )}
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

/** The peak-to-trough pair that fell furthest, for shading. */
function deepestTrough(values: number[]): {
  peakIndex: number;
  troughIndex: number;
  peakValue: number;
  troughValue: number;
} | null {
  let peak = values[0] ?? 0;
  let peakIndex = 0;
  let worst: {
    peakIndex: number;
    troughIndex: number;
    peakValue: number;
    troughValue: number;
  } | null = null;
  let worstFall = 0;

  values.forEach((value, index) => {
    if (value > peak) {
      peak = value;
      peakIndex = index;
    }
    const fall = peak - value;
    if (fall > worstFall) {
      worstFall = fall;
      worst = { peakIndex, troughIndex: index, peakValue: peak, troughValue: value };
    }
  });

  return worst;
}
