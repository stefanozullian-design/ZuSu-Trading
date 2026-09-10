import { authenticator } from 'otplib';
import QRCode from 'qrcode';

/**
 * TOTP second factor (RFC 6238). Required for administrators (§52) — the role
 * that can change risk limits and release a kill switch.
 */
authenticator.options = {
  // One step of tolerance either side: enough for clock drift, not enough to
  // make a stolen code broadly reusable.
  window: 1,
  step: 30,
  digits: 6,
};

export const MFA_ISSUER = 'ZuSu Trading';

export function generateMfaSecret(): string {
  return authenticator.generateSecret(20);
}

export function buildOtpauthUrl(accountEmail: string, secret: string): string {
  return authenticator.keyuri(accountEmail, MFA_ISSUER, secret);
}

export async function buildQrDataUrl(otpauthUrl: string): Promise<string> {
  return QRCode.toDataURL(otpauthUrl, { errorCorrectionLevel: 'M', margin: 1, width: 240 });
}

export function verifyTotp(token: string, secret: string): boolean {
  try {
    return authenticator.check(token, secret);
  } catch {
    return false;
  }
}

/** Current code for a secret. Used only by tests and the enrolment preview. */
export function currentTotp(secret: string): string {
  return authenticator.generate(secret);
}
