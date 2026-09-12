/**
 * Shared plumbing for the market charts.
 *
 * Hand-rolled rather than pulled from a chart library: the whole point of these
 * panels is that a null indicator must render as a *break in the line* rather
 * than a drop to zero, and most libraries make that the hard path.
 */

/** The validated categorical palette for these charts (dark surface #0F1219). */
export const SERIES_COLORS = {
  price: '#0284C7',
  fast: '#D97706',
  slow: '#8B5CF6',
} as const;

export interface Scale {
  (value: number): number;
}

export function linearScale(domain: [number, number], range: [number, number]): Scale {
  const d0 = domain[0];
  const d1 = domain[1];
  const r0 = range[0];
  const r1 = range[1];
  const span = d1 - d0;
  // A zero-width domain would divide by zero; centre the flat series instead.
  if (span === 0) return () => (r0 + r1) / 2;
  return (value: number) => r0 + ((value - d0) / span) * (r1 - r0);
}

/** Min and max over several nullable series, ignoring the gaps. */
export function extentOf(...series: (number | null)[][]): [number, number] {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const values of series) {
    for (const value of values) {
      if (value === null || !Number.isFinite(value)) continue;
      if (value < min) min = value;
      if (value > max) max = value;
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  if (min === max) return [min - 1, max + 1];
  return [min, max];
}

/** Pads a domain by a fraction so marks do not touch the frame. */
export function padDomain(extent: [number, number], fraction = 0.06): [number, number] {
  const min = extent[0];
  const max = extent[1];
  const pad = (max - min) * fraction;
  return [min - pad, max + pad];
}

/**
 * An SVG path for a series that may have gaps.
 *
 * Each run of defined values becomes its own subpath, so a warm-up period or a
 * missing bar leaves a visible break. Joining across a null would draw a
 * straight line through data that does not exist.
 */
export function linePath(values: (number | null)[], x: Scale, y: Scale): string {
  const parts: string[] = [];
  let open = false;
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];
    if (value === null || value === undefined || !Number.isFinite(value)) {
      open = false;
      continue;
    }
    const command = open ? 'L' : 'M';
    parts.push(`${command}${x(i).toFixed(2)},${y(value).toFixed(2)}`);
    open = true;
  }
  return parts.join(' ');
}

/** A closed band between two nullable series, for a Bollinger envelope. */
export function bandPath(
  upper: (number | null)[],
  lower: (number | null)[],
  x: Scale,
  y: Scale,
): string {
  const top: string[] = [];
  const bottom: string[] = [];
  for (let i = 0; i < upper.length; i += 1) {
    const u = upper[i];
    const l = lower[i];
    if (u === null || u === undefined || l === null || l === undefined) continue;
    top.push(`${x(i).toFixed(2)},${y(u).toFixed(2)}`);
    bottom.unshift(`${x(i).toFixed(2)},${y(l).toFixed(2)}`);
  }
  if (top.length === 0) return '';
  return `M${top.join(' L')} L${bottom.join(' L')} Z`;
}

/** Roughly `count` gridline values inside a domain, on rounded steps. */
export function ticksFor(domain: [number, number], count = 5): number[] {
  const min = domain[0];
  const max = domain[1];
  const raw = (max - min) / count;
  const magnitude = Math.pow(10, Math.floor(Math.log10(raw)));
  const normalised = raw / magnitude;
  const step =
    (normalised >= 7.5 ? 10 : normalised >= 3.5 ? 5 : normalised >= 1.5 ? 2 : 1) * magnitude;

  const ticks: number[] = [];
  for (let t = Math.ceil(min / step) * step; t <= max; t += step) {
    ticks.push(Number(t.toFixed(10)));
  }
  return ticks;
}

export function num(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Compact axis label: 1.2k, 3.4M. */
export function compact(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return value.toFixed(abs < 10 ? 2 : 0);
}

export function timeLabel(iso: string, timeframe: string): string {
  const date = new Date(iso);
  if (timeframe === '1d') {
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
  }
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
  });
}
