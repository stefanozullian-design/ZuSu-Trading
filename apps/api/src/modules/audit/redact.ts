/** Key names whose values are stripped before anything is persisted or logged. */
const SECRET_KEY_PATTERN =
  /(password|secret|token|credential|apikey|api_key|authorization|cookie|mfa|otp|private)/i;

export const REDACTED = '[redacted]';

/**
 * Deep-copies a value, replacing anything that looks like a secret. Audit
 * records keep before/after snapshots, so this runs on every write (§53).
 */
export function redactDeep(value: unknown, depth = 0): unknown {
  if (depth > 12) return '[truncated]';
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY_PATTERN.test(key) ? REDACTED : redactDeep(val, depth + 1);
    }
    return out;
  }
  if (typeof value === 'bigint') return value.toString();
  return value;
}

/** Deterministic serialisation: object keys sorted so hashes are reproducible. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sortKeys);
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return Object.fromEntries(entries.map(([k, v]) => [k, sortKeys(v)]));
}
