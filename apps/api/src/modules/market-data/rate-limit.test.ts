import { describe, expect, it } from 'vitest';
import { readRateLimit } from './massive-provider.js';

/**
 * Reading a plan's rate limit off a response.
 *
 * The distinction this exists to preserve: **"the provider said nothing" and
 * "the provider said zero" are different answers.** A single nullable number
 * conflates them, and the conflation is dangerous in the reassuring
 * direction — silence renders as "unknown", which a hurried reader takes for
 * "fine", right up until the import dies at symbol 94.
 */

function headers(values: Record<string, string>): Headers {
  return new Headers(values);
}

describe('reading the rate limit', () => {
  it('reports what was present and names which headers carried it', () => {
    const reading = readRateLimit(
      headers({ 'x-ratelimit-limit': '100', 'x-ratelimit-remaining': '97' }),
    );

    expect(reading.limit).toBe(100);
    expect(reading.remaining).toBe(97);
    expect(reading.headers).toEqual(['x-ratelimit-limit', 'x-ratelimit-remaining']);
  });

  it('distinguishes a silent provider from an exhausted one', () => {
    const silent = readRateLimit(headers({}));
    const exhausted = readRateLimit(headers({ 'x-ratelimit-remaining': '0' }));

    // Both have a falsy remaining. Only one of them is out of quota, and a
    // caller that cannot tell will either panic or press on, wrongly.
    expect(silent.remaining).toBeNull();
    expect(silent.headers).toEqual([]);
    expect(exhausted.remaining).toBe(0);
    expect(exhausted.headers).toEqual(['x-ratelimit-remaining']);
  });

  it('accepts the un-prefixed spelling some providers use', () => {
    const reading = readRateLimit(headers({ 'ratelimit-remaining': '42' }));
    expect(reading.remaining).toBe(42);
  });

  it('prefers the x- spelling when a response carries both', () => {
    const reading = readRateLimit(
      headers({ 'x-ratelimit-remaining': '5', 'ratelimit-remaining': '500' }),
    );
    // Guessing wrong here means a paced import that is either needlessly slow
    // or certain to be refused, so the order is fixed rather than incidental.
    expect(reading.remaining).toBe(5);
  });

  it('keeps reset and retry-after raw, because providers disagree on the unit', () => {
    const reading = readRateLimit(
      headers({ 'x-ratelimit-reset': '1774041600', 'retry-after': '60' }),
    );

    // One is an epoch and the other a delay in seconds — and which is which
    // varies by provider. Converting either would be inventing a meaning.
    expect(reading.resetRaw).toBe('1774041600');
    expect(reading.retryAfterRaw).toBe('60');
  });

  it('treats an unparseable value as absent rather than as zero', () => {
    const reading = readRateLimit(headers({ 'x-ratelimit-remaining': 'unlimited' }));
    expect(reading.remaining).toBeNull();
    // Still recorded as present: the header exists, its value is just not a
    // number, and a reader deciding whether to trust the figure needs to know.
    expect(reading.headers).toContain('x-ratelimit-remaining');
  });
});
