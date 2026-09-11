/**
 * Formatting helpers.
 *
 * Money arrives from the API as decimal strings so no precision is lost in
 * transit; it is parsed only at the moment of display.
 */
export function formatMoney(value: string | null | undefined, currency = 'USD'): string {
  if (value === null || value === undefined) return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
}

export function formatSignedMoney(value: string | null | undefined, currency = 'USD'): string {
  if (value === null || value === undefined) return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return `${n > 0 ? '+' : ''}${formatMoney(value, currency)}`;
}

export function formatPercent(value: string | null | undefined, digits = 2): string {
  if (value === null || value === undefined) return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return `${n > 0 ? '+' : ''}${n.toFixed(digits)}%`;
}

export function formatQuantity(value: string | null | undefined): string {
  if (value === null || value === undefined) return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 8 }).format(n);
}

export function formatPrice(value: string | null | undefined): string {
  if (value === null || value === undefined) return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return n.toFixed(2);
}

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('en-US', { hour12: false });
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-US', { hour12: false });
}

/** Positive/negative colour class, or neutral when there is nothing to show. */
export function pnlTone(value: string | null | undefined): string {
  if (value === null || value === undefined) return 'text-muted-foreground';
  const n = Number(value);
  if (!Number.isFinite(n) || n === 0) return 'text-muted-foreground';
  return n > 0 ? 'text-profit' : 'text-loss';
}
