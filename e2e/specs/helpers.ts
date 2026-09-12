import { expect, type Page } from '@playwright/test';

/** Seeded accounts. Passwords are demo-only and live in the seed script. */
export const ACCOUNTS = {
  admin: { email: 'admin@zusu.local', password: 'DemoTrading2026!' },
  manager: { email: 'manager@zusu.local', password: 'DemoTrading2026!' },
  viewer: { email: 'viewer@zusu.local', password: 'DemoTrading2026!' },
  client: { email: 'client@zusu.local', password: 'DemoTrading2026!' },
} as const;

/**
 * Signs in and waits for the shell to appear.
 *
 * Only for accounts without a second factor. The administrator is forced
 * through MFA, which `signInAdmin` handles.
 */
export async function signIn(page: Page, account: keyof typeof ACCOUNTS): Promise<void> {
  const { email, password } = ACCOUNTS[account];

  await page.goto('/');
  await page.getByLabel(/email/i).fill(email);
  await page.getByLabel(/password/i).fill(password);
  await page.getByRole('button', { name: /sign in/i }).click();

  // The nav only renders once a session exists, so this is the real signal
  // that authentication succeeded rather than a timer.
  await expect(page.getByRole('link', { name: /dashboard/i })).toBeVisible();
}

export async function signOut(page: Page): Promise<void> {
  await page.getByRole('button', { name: /sign out/i }).click();
  await expect(page.getByRole('button', { name: /sign in/i })).toBeVisible();
}

/**
 * Signs the administrator in, enrolling or satisfying the second factor.
 *
 * Administrators cannot opt out of MFA, so there is no way to reach an admin
 * session without doing this — which makes it worth exercising rather than
 * working around. The code is generated from the secret the enrolment screen
 * shows, exactly as an authenticator app would.
 */
export async function signInAdmin(page: Page): Promise<void> {
  const { authenticator } = await import('otplib');

  await page.goto('/');
  await page.getByLabel(/email/i).fill(ACCOUNTS.admin.email);
  await page.getByLabel(/password/i).fill(ACCOUNTS.admin.password);
  await page.getByRole('button', { name: /sign in/i }).click();

  const enrolling = page.getByRole('button', { name: /activate and sign in/i });
  const verifying = page.getByRole('button', { name: /^verify$/i });
  await expect(enrolling.or(verifying)).toBeVisible();

  if (await enrolling.isVisible()) {
    // The secret is behind a disclosure for people typing it by hand; that is
    // also the only place a test can read it.
    await page.getByText(/enter the key manually/i).click();
    const secret = (await page.locator('code').first().innerText()).replace(/\s/g, '');
    expect(secret.length).toBeGreaterThan(10);

    await page.getByLabel(/six-digit code/i).fill(authenticator.generate(secret));
    await enrolling.click();
  } else {
    throw new Error('Admin already has MFA enrolled; this suite expects a freshly seeded database');
  }

  await expect(page.getByRole('link', { name: /dashboard/i })).toBeVisible();
}
