import { useMemo, useRef, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { MarketCandle } from '@/lib/types';
import {
  SERIES_COLORS,
  bandPath,
  compact,
  extentOf,
  linePath,
  linearScale,
  num,
  padDomain,
  ticksFor,
  timeLabel,
} from './chart-primitives';

interface Props {
  symbol: string;
  timeframe: string;
  candles: MarketCandle[];
  /** Overlay series, already aligned 1:1 with `candles`. */
  overlays: {
    sma20: (number | null)[];
    sma50: (number | null)[];
    bollingerUpper: (number | null)[];
    bollingerLower: (number | null)[];
  };
  provider: string;
}

const WIDTH = 940;
const HEIGHT = 340;
const PAD = { top: 12, right: 58, bottom: 26, left: 8 };

/**
 * Close price with its moving averages and Bollinger envelope.
 *
 * One y-axis only: every series here is in price units. Volume deliberately
 * gets no second scale — a dual-axis chart invites a reader to see a
 * correlation that the axes invented.
 */
export function PriceChart({ symbol, timeframe, candles, overlays, provider }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);

  const closes = useMemo(() => candles.map((c) => num(c.close)), [candles]);

  const plot = {
    x0: PAD.left,
    x1: WIDTH - PAD.right,
    y0: PAD.top,
    y1: HEIGHT - PAD.bottom,
  };

  const domain = padDomain(
    extentOf(
      closes,
      overlays.sma20,
      overlays.sma50,
      overlays.bollingerUpper,
      overlays.bollingerLower,
    ),
  );
  const x = linearScale([0, Math.max(candles.length - 1, 1)], [plot.x0, plot.x1]);
  const y = linearScale(domain, [plot.y1, plot.y0]);
  const ticks = ticksFor(domain, 5);

  const series = [
    { key: 'close', label: 'Close', color: SERIES_COLORS.price, values: closes, width: 2 },
    {
      key: 'sma20',
      label: 'SMA 20',
      color: SERIES_COLORS.fast,
      values: overlays.sma20,
      width: 1.5,
    },
    {
      key: 'sma50',
      label: 'SMA 50',
      color: SERIES_COLORS.slow,
      values: overlays.sma50,
      width: 1.5,
    },
  ];

  function onMove(event: React.PointerEvent<SVGSVGElement>) {
    const svg = svgRef.current;
    if (!svg || candles.length === 0) return;
    const rect = svg.getBoundingClientRect();
    // The SVG scales to its container, so map client px back to viewBox units.
    const viewX = ((event.clientX - rect.left) / rect.width) * WIDTH;
    const ratio = (viewX - plot.x0) / (plot.x1 - plot.x0);
    const index = Math.round(ratio * (candles.length - 1));
    setHover(Math.max(0, Math.min(candles.length - 1, index)));
  }

  const hovered = hover === null ? null : candles[hover];

  return (
    <Card>
      <CardHeader className="flex-row items-baseline justify-between gap-2">
        <CardTitle>
          {symbol} · {timeframe} · close, moving averages and Bollinger band
        </CardTitle>
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
          {candles.length} bars · {provider}
        </span>
      </CardHeader>
      <CardContent>
        {candles.length === 0 ? (
          <p className="py-16 text-center text-sm text-muted-foreground">
            No stored bars for {symbol} at {timeframe}.
          </p>
        ) : (
          <>
            {/* Legend: identity is never colour alone, so each swatch is labelled. */}
            <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
              {series.map((s) => (
                <span key={s.key} className="flex items-center gap-1.5">
                  <svg width="14" height="4" aria-hidden>
                    <rect width="14" height="3" rx="1.5" fill={s.color} />
                  </svg>
                  {s.label}
                </span>
              ))}
              <span className="flex items-center gap-1.5">
                <svg width="14" height="8" aria-hidden>
                  <rect width="14" height="8" rx="2" fill={SERIES_COLORS.price} opacity="0.16" />
                </svg>
                Bollinger 20, 2σ
              </span>
            </div>

            <svg
              ref={svgRef}
              viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
              className="w-full touch-none"
              role="img"
              aria-label={`${symbol} close price with SMA 20, SMA 50 and Bollinger bands over ${String(candles.length)} ${timeframe} bars`}
              onPointerMove={onMove}
              onPointerLeave={() => setHover(null)}
            >
              {/* Recessive gridlines and right-hand price labels. */}
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
                    opacity="0.5"
                  />
                  <text
                    x={plot.x1 + 6}
                    y={y(tick) + 3.5}
                    className="fill-muted-foreground"
                    fontSize="10"
                  >
                    {compact(tick)}
                  </text>
                </g>
              ))}

              <path
                d={bandPath(overlays.bollingerUpper, overlays.bollingerLower, x, y)}
                fill={SERIES_COLORS.price}
                opacity="0.14"
              />

              {series.map((s) => (
                <path
                  key={s.key}
                  d={linePath(s.values, x, y)}
                  fill="none"
                  stroke={s.color}
                  strokeWidth={s.width}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              ))}

              {/* Time labels at both ends and the middle — enough to orient
                  without crowding the axis. */}
              {[0, Math.floor(candles.length / 2), candles.length - 1]
                .filter((i, pos, all) => all.indexOf(i) === pos && candles[i])
                .map((i) => (
                  <text
                    key={i}
                    x={x(i)}
                    y={HEIGHT - 8}
                    textAnchor={i === 0 ? 'start' : i === candles.length - 1 ? 'end' : 'middle'}
                    className="fill-muted-foreground"
                    fontSize="10"
                  >
                    {timeLabel((candles[i] as MarketCandle).openTime, timeframe)}
                  </text>
                ))}

              {hover !== null && hovered && (
                <g>
                  <line
                    x1={x(hover)}
                    x2={x(hover)}
                    y1={plot.y0}
                    y2={plot.y1}
                    stroke="currentColor"
                    className="text-muted-foreground"
                    strokeWidth="1"
                    strokeDasharray="3 3"
                  />
                  {series.map((s) => {
                    const value = s.values[hover];
                    if (value === null || value === undefined) return null;
                    return (
                      <circle
                        key={s.key}
                        cx={x(hover)}
                        cy={y(value)}
                        r="4"
                        fill={s.color}
                        stroke="hsl(var(--card))"
                        strokeWidth="2"
                      />
                    );
                  })}
                </g>
              )}
            </svg>

            <div className="mt-1 min-h-[34px] text-xs">
              {hovered ? (
                <div className="flex flex-wrap items-baseline gap-x-4 gap-y-0.5">
                  <span className="text-muted-foreground">
                    {timeLabel(hovered.openTime, timeframe)} UTC
                  </span>
                  <span>
                    O <span className="text-muted-foreground">{hovered.open}</span> H{' '}
                    <span className="text-muted-foreground">{hovered.high}</span> L{' '}
                    <span className="text-muted-foreground">{hovered.low}</span> C{' '}
                    <span className="font-medium">{hovered.close}</span>
                  </span>
                  <span className="text-muted-foreground">
                    vol {compact(num(hovered.volume) ?? 0)}
                  </span>
                  {series.slice(1).map((s) => {
                    const value = s.values[hover as number];
                    return (
                      <span key={s.key} className="text-muted-foreground">
                        {s.label} {value === null || value === undefined ? '—' : value.toFixed(2)}
                      </span>
                    );
                  })}
                </div>
              ) : (
                <span className="text-muted-foreground">
                  Hover the chart for the values at a bar.
                </span>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
