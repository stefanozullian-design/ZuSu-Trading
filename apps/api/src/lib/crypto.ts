import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
  scrypt as scryptCb,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem?: number },
) => Promise<Buffer>;

// ---------------------------------------------------------------------------
// Password hashing (scrypt — memory-hard, no native build step)
// ---------------------------------------------------------------------------

const SCRYPT_PARAMS = { N: 2 ** 15, r: 8, p: 1 } as const;
const KEY_LENGTH = 64;
const MAXMEM = 128 * SCRYPT_PARAMS.N * SCRYPT_PARAMS.r * 2;

/** Produces `scrypt$N$r$p$salt$hash`, all base64url. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password.normalize('NFKC'), salt, KEY_LENGTH, {
    ...SCRYPT_PARAMS,
    maxmem: MAXMEM,
  });
  const { N, r, p } = SCRYPT_PARAMS;
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}

/** Constant-time verification. Returns false for any malformed stored hash. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, nRaw, rRaw, pRaw, saltRaw, hashRaw] = parts;
  const N = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  if (!saltRaw || !hashRaw) return false;

  const expected = Buffer.from(hashRaw, 'base64url');
  let derived: Buffer;
  try {
    derived = await scrypt(
      password.normalize('NFKC'),
      Buffer.from(saltRaw, 'base64url'),
      expected.length,
      {
        N,
        r,
        p,
        maxmem: 128 * N * r * 2,
      },
    );
  } catch {
    return false;
  }
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

// ---------------------------------------------------------------------------
// Opaque tokens
// ---------------------------------------------------------------------------

export function generateOpaqueToken(bytes = 48): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export { randomUUID };

// ---------------------------------------------------------------------------
// Envelope encryption for credentials at rest (§52)
// ---------------------------------------------------------------------------

const ENVELOPE_VERSION = 'v1';

export class SecretBox {
  readonly #key: Buffer;

  constructor(base64Key: string) {
    const key = Buffer.from(base64Key, 'base64');
    if (key.length !== 32) {
      throw new Error('SecretBox requires a 32-byte key encoded as base64');
    }
    this.#key = key;
  }

  /** Returns `v1:<iv>:<tag>:<ciphertext>`, all base64url. */
  encrypt(plaintext: string, aad?: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#key, iv);
    if (aad) cipher.setAAD(Buffer.from(aad, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [
      ENVELOPE_VERSION,
      iv.toString('base64url'),
      tag.toString('base64url'),
      ciphertext.toString('base64url'),
    ].join(':');
  }

  decrypt(envelope: string, aad?: string): string {
    const parts = envelope.split(':');
    if (parts.length !== 4 || parts[0] !== ENVELOPE_VERSION) {
      throw new Error('Unrecognised credential envelope');
    }
    const [, ivRaw, tagRaw, dataRaw] = parts;
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.#key,
      Buffer.from(ivRaw as string, 'base64url'),
    );
    if (aad) decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(Buffer.from(tagRaw as string, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(dataRaw as string, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  }
}
