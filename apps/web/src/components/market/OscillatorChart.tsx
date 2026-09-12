import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  SERIES_COLORS,
  compact,
  extentOf,
  linePath,
  linearScale,
  padDomain,
  ticksFor,
} from './chart-primitives';

const WIDTH = 460;
const HEIGHT = 150;
const PAD = { top: 10, right: 44, bottom: 14, left: 6 };

interface Line {
  label: string;
  color: string;
  values: (number | null)[];
}

interface Props {
  title: string;
  lines: Line[];
  /** Signed bars drawn around zero, as MACD's histogram is. */
  histogram?: (number | null)[];
  /** Horizontal reference lines, e.g. RSI's 30 and 70. */
  references?: { value: number; label: string }[];
  /** Fixes the y-domain, for a bounded oscillator like RSI. */
  domain?: [number, number];
  caption?: string;
}

/**
 * A small panel for an oscillator that does not share the price axis.
 *
 * These are separate charts rather than overlays on the price chart for one
 * reason: RSI runs 0-100 and MACD straddles zero, and putting either on a
 * price axis would need a second y-scale. A dual-axis chart makes a reader see
 * a relationship the axes invented, so there isn't one anywhere here.
 */
export function OscillatorChart({
  title,
  lines,
  histogram,
  references = [],
  domain,
  caption,
}: Props) {
  const length = Math.max(...lines.map((l) => l.values.length), histogram?.length ?? 0, 1);

  const resolved =
    domain ??
    padDomain(
      extentOf(
        ...lines.map((l) => l.values),
        histogram ?? [],
        // Zero is always in frame for a signed series, so the baseline means
        // something.
        histogram ? [0] : [],
      ),
    );

  const plot = { x0: PAD.left, x1: WIDTH - PAD.right, y0: PAD.top, y1: HEIGHT - PAD.bottom };
  const x = linearScale([0, Math.max(length - 1, 1)], [plot.x0, plot.x1]);
  const y = linearScale(resolved, [plot.y1, plot.y0]);
  const ticks = domain ? references.map((r) => r.value) : ticksFor(resolved, 3);
  const barWidth = Math.max(1, (plot.x1 - plot.x0) / length - 0.5);

  return (
    <Card>
      <CardHeader className="flex-row items-baseline justify-between gap-2">
        <CardTitle>{title}</CardTitle>
        {lines.length > 1 && (
          <span className="flex items-center gap-3 text-[10px] text-muted-foreground">
            {lines.map((line) => (
              <span key={line.label} className="flex items-center gap-1">
                <svg width="12" height="3" aria-hidden>
                  <rect width="12" height="3" rx="1.5" fill={line.color} />
                </svg>
                {line.label}
              </span>
            ))}
          </span>
        )}
      </CardHeader>
      <CardContent>
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          className="w-full"
          role="img"
          aria-label={`${title}${caption ? `. ${caption}` : ''}`}
        >
          {ticks.map((tick) => (
            <g key={tick}>
              <line
                x1={plot.x0}
                x2={plot.x1}
                y1={y(tick)}
                y2={y(tick)}
                stroke="currentColor"
                className="text-border"
                strokeWidth="1"
                opacity="0.55"
                strokeDasharray={references.some((r) => r.value === tick) ? '4 3' : undefined}
              />
              <text
                x={plot.x1 + 5}
                y={y(tick) + 3.5}
                className="fill-muted-foreground"
                fontSize="9"
              >
                {compact(tick)}
              </text>
            </g>
          ))}

          {histogram && (
            <>
              <line
                x1={plot.x0}
                x2={plot.x1}
                y1={y(0)}
                y2={y(0)}
                stroke="currentColor"
                className="text-border"
                strokeWidth="1"
              />
              {histogram.map((value, i) => {
                if (value === null) return null;
                const top = Math.min(y(value), y(0));
                const height = Math.abs(y(value) - y(0));
                return (
                  <rect
                    key={i}
                    x={x(i) - barWidth / 2}
                    y={top}
                    width={barWidth}
                    height={Math.max(height, 0.75)}
                    rx={Math.min(1.5, barWidth / 2)}
                    // Signed magnitude, so the app's own profit/loss pair with a
                    // zero baseline — not a categorical hue.
                    fill={value >= 0 ? 'hsl(var(--profit))' : 'hsl(var(--loss))'}
                    opacity="0.75"
                  />
                );
              })}
            </>
          )}

          {lines.map((line) => (
            <path
              key={line.label}
              d={linePath(line.values, x, y)}
              fill="none"
              stroke={line.color}
              strokeWidth="1.75"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ))}
        </svg>

        {caption && <p className="mt-1 text-[11px] text-muted-foreground">{caption}</p>}
      </CardContent>
    </Card>
  );
}

export { SERIES_COLORS };
