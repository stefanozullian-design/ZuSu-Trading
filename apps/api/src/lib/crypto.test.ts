import { describe, expect, it } from 'vitest';
import {
  SecretBox,
  constantTimeEquals,
  generateOpaqueToken,
  hashPassword,
  sha256,
  verifyPassword,
} from './crypto.js';

const KEY = Buffer.alloc(32, 3).toString('base64');

describe('password hashing', () => {
  it('never stores the password and verifies the right one', async () => {
    const hash = await hashPassword('CorrectHorseBattery1!');
    expect(hash).not.toContain('CorrectHorseBattery1!');
    expect(hash.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword('CorrectHorseBattery1!', hash)).toBe(true);
    expect(await verifyPassword('correcthorsebattery1!', hash)).toBe(false);
  });

  it('salts each hash so identical passwords differ on disk', async () => {
    const [a, b] = await Promise.all([
      hashPassword('same-password-x'),
      hashPassword('same-password-x'),
    ]);
    expect(a).not.toBe(b);
  });

  it('returns false rather than throwing on a malformed stored hash', async () => {
    for (const bad of ['', 'not-a-hash', 'scrypt$x$y$z$q$r', 'bcrypt$1$2$3$4$5']) {
      expect(await verifyPassword('anything', bad)).toBe(false);
    }
  });
});

describe('SecretBox', () => {
  it('round-trips a credential', () => {
    const box = new SecretBox(KEY);
    const envelope = box.encrypt('broker-api-secret', 'account-1');
    expect(envelope).not.toContain('broker-api-secret');
    expect(envelope.startsWith('v1:')).toBe(true);
    expect(box.decrypt(envelope, 'account-1')).toBe('broker-api-secret');
  });

  it('refuses a tampered ciphertext', () => {
    const box = new SecretBox(KEY);
    const envelope = box.encrypt('secret-value');
    const parts = envelope.split(':');
    const tampered = [parts[0], parts[1], parts[2], `${parts[3]}AA`].join(':');
    expect(() => box.decrypt(tampered)).toThrow();
  });

  it('refuses to decrypt under a different associated context', () => {
    const box = new SecretBox(KEY);
    const envelope = box.encrypt('secret-value', 'user-a');
    expect(() => box.decrypt(envelope, 'user-b')).toThrow();
  });

  it('refuses a key of the wrong length', () => {
    expect(() => new SecretBox(Buffer.alloc(16).toString('base64'))).toThrow();
  });
});

describe('tokens', () => {
  it('generates distinct, url-safe tokens', () => {
    const tokens = new Set(Array.from({ length: 200 }, () => generateOpaqueToken(32)));
    expect(tokens.size).toBe(200);
    for (const token of tokens) expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('hashes deterministically', () => {
    expect(sha256('abc')).toBe(sha256('abc'));
    expect(sha256('abc')).not.toBe(sha256('abd'));
    expect(sha256('abc')).toHaveLength(64);
  });

  it('compares in constant time without leaking on length', () => {
    expect(constantTimeEquals('token', 'token')).toBe(true);
    expect(constantTimeEquals('token', 'token-longer')).toBe(false);
    expect(constantTimeEquals('token', 'toker')).toBe(false);
  });
});
