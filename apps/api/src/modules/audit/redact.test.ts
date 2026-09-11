import { describe, expect, it } from 'vitest';
import { REDACTED, canonicalJson, redactDeep } from './redact.js';

describe('redactDeep', () => {
  it('strips anything that looks like a secret, at any depth', () => {
    const redacted = redactDeep({
      email: 'user@example.com',
      password: 'hunter2',
      broker: { apiKey: 'live-key', credentials: { secret: 's' }, accountId: 'A-1' },
      list: [{ mfaSecret: 'abc' }],
    }) as Record<string, any>;

    expect(redacted.email).toBe('user@example.com');
    expect(redacted.password).toBe(REDACTED);
    expect(redacted.broker.apiKey).toBe(REDACTED);
    expect(redacted.broker.credentials).toBe(REDACTED);
    expect(redacted.broker.accountId).toBe('A-1');
    expect(redacted.list[0].mfaSecret).toBe(REDACTED);
    expect(JSON.stringify(redacted)).not.toContain('hunter2');
  });

  it('normalises dates, bigints and cycles-by-depth', () => {
    const date = new Date('2026-01-02T03:04:05.000Z');
    expect(redactDeep({ at: date })).toEqual({ at: '2026-01-02T03:04:05.000Z' });
    expect(redactDeep({ n: 10n })).toEqual({ n: '10' });

    const deep: Record<string, unknown> = {};
    let node = deep;
    for (let i = 0; i < 20; i += 1) {
      node.child = {};
      node = node.child as Record<string, unknown>;
    }
    expect(() => redactDeep(deep)).not.toThrow();
  });
});

describe('canonicalJson', () => {
  it('is stable regardless of key order', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    expect(canonicalJson({ a: { d: 1, c: 2 } })).toBe('{"a":{"c":2,"d":1}}');
  });

  it('distinguishes different values', () => {
    expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ a: 2 }));
  });

  it('drops undefined so an absent field and a missing field hash alike', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
  });
});
