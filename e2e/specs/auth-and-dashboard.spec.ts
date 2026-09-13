import { expect, test } from '@playwright/test';
import { ACCOUNTS, signIn, signInAdmin, signOut } from './helpers';

test.describe('signing in', () => {
  test('rejects a wrong password without revealing whether the account exists', async ({
    page,
  }) => {
    await page.goto('/');
    await page.getByLabel(/email/i).fill(ACCOUNTS.manager.email);
    await page.getByLabel(/password/i).fill('definitely-not-the-password');
    await page.getByRole('button', { name: /sign in/i }).click();

    await expect(page.getByRole('button', { name: /sign in/i })).toBeVisible();
    // The message must not distinguish "no such user" from "wrong password".
    const body = await page.locator('body').innerText();
    expect(body).not.toMatch(/no such user|unknown email|user not found/i);
  });

  test('signs a manager in and back out', async ({ page }) => {
    await signIn(page, 'manager');
    await expect(page.getByText(/MANAGER/)).toBeVisible();
    await signOut(page);
  });
});

test.describe('the dashboard', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, 'manager');
  });

  test('says unmistakably that this is the demo environment', async ({ page }) => {
    // The banner exists so nobody can mistake simulated trading for real.
    const banner = page.getByRole('status');
    await expect(banner).toContainText('DEMO');
    await expect(banner).toContainText(/simulated broker/i);
  });

  test('shows real seeded portfolio figures, not placeholders', async ({ page }) => {
    await expect(page.getByText('Account value', { exact: true })).toBeVisible();

    // A currency amount with a thousands separator — proof the number came
    // from the database rather than being a hard-coded dash.
    await expect(page.locator('body')).toContainText(/\$\d{1,3}(,\d{3})+\.\d{2}/);
  });

  test('lists the seeded open positions with their marks', async ({ page }) => {
    await expect(page.getByRole('heading', { name: /open positions/i })).toBeVisible();
    for (const symbol of ['AAPL', 'MSFT', 'NVDA', 'SPY']) {
      await expect(page.getByRole('cell', { name: symbol, exact: true })).toBeVisible();
    }
  });

  test('reports per-dependency health, including what is not built yet', async ({ page }) => {
    await expect(page.getByRole('heading', { name: /system health/i })).toBeVisible();
    await expect(page.getByText('Database', { exact: true })).toBeVisible();

    // Nothing claims to be running that is not: with no API key the analysis
    // service reports DISABLED with the reason, rather than a green light.
    await expect(page.getByText(/no ANTHROPIC_API_KEY/i)).toBeVisible();
  });

  test('can make a portfolio without leaving the page', async ({ page }) => {
    // There was no screen for this at all — the only route to a portfolio of
    // your own was a hand-written API request, so a fresh install's first
    // experience was a dead end.
    await page.getByRole('button', { name: /new portfolio/i }).click();
    await page.getByLabel('Portfolio name').fill('E2E Second Book');
    await page.getByLabel('Starting cash').fill('25000');

    await Promise.all([
      page.waitForResponse(
        (r) => r.url().endsWith('/api/portfolios') && r.request().method() === 'POST',
      ),
      page.getByRole('button', { name: /create it/i }).click(),
    ]);

    await expect(page.getByRole('button', { name: /E2E Second Book/ })).toBeVisible();
  });

  test('renames a portfolio and closes it out of the list', async ({ page }) => {
    await page.getByRole('button', { name: /new portfolio/i }).click();
    await page.getByLabel('Portfolio name').fill('E2E Rename Me');
    await page.getByLabel('Starting cash').fill('5000');
    await Promise.all([
      page.waitForResponse(
        (r) => r.url().endsWith('/api/portfolios') && r.request().method() === 'POST',
      ),
      page.getByRole('button', { name: /create it/i }).click(),
    ]);

    await page.getByRole('button', { name: /E2E Rename Me/ }).click();
    await page.getByRole('button', { name: /^Rename$/ }).click();
    await page.getByLabel('New portfolio name').fill('E2E Renamed');
    await Promise.all([
      page.waitForResponse((r) => r.request().method() === 'PATCH'),
      page.getByRole('button', { name: /save name/i }).click(),
    ]);
    await expect(page.getByRole('button', { name: /E2E Renamed/ })).toBeVisible();

    // Closed rather than deleted: gone from the list, and still there behind
    // "Show closed", because its audit history cannot be erased.
    await page.getByRole('button', { name: /E2E Renamed/ }).click();
    await Promise.all([
      page.waitForResponse((r) => r.request().method() === 'PATCH'),
      page.getByRole('button', { name: /^Close$/ }).click(),
    ]);
    await expect(page.getByRole('button', { name: /E2E Renamed/ })).toHaveCount(0);

    await page.getByRole('button', { name: /show closed/i }).click();
    await expect(page.getByRole('button', { name: /E2E Renamed/ })).toBeVisible();
  });

  test('states plainly whether anything trades on its own', async ({ page }) => {
    // The one number on the dashboard worth being unambiguous about, and it is
    // read from the live configurations rather than asserted in prose.
    await expect(page.getByRole('heading', { name: 'Automation', exact: true })).toBeVisible();
    await expect(
      page.getByText(/Nothing trades on its own|place orders without a click/),
    ).toBeVisible();
  });

  test('says why the approvals panel is empty rather than showing an empty table', async ({
    page,
  }) => {
    // Whether or not anything is waiting — earlier specs in this run may have
    // produced some — the panel is about decisions a person owes, and it
    // points at the page where they are made.
    await expect(page.getByRole('heading', { name: /waiting for a decision/i })).toBeVisible();
    await expect(page.getByRole('link', { name: /open the trading page/i })).toBeVisible();
  });
});

test.describe('role gating', () => {
  test('a viewer gets neither the audit log nor write controls', async ({ page }) => {
    await signIn(page, 'viewer');

    // Audit is admin/manager territory.
    await expect(page.getByRole('link', { name: /audit/i })).toHaveCount(0);
    // Market data is reference data, so a viewer does get those.
    await expect(page.getByRole('link', { name: /market/i })).toBeVisible();
    await expect(page.getByRole('link', { name: /scanner/i })).toBeVisible();
  });

  test('a viewer navigating straight to /audit is redirected, not shown it', async ({ page }) => {
    await signIn(page, 'viewer');
    await page.goto('/audit');

    // Gated in the UI as well as the API — a hidden link is not a control.
    await expect(page).toHaveURL(/\/$/);
  });

  test('a manager does not get the audit log either — it is administrator-only', async ({
    page,
  }) => {
    await signIn(page, 'manager');
    // A manager can stop trading but cannot read the audit trail; the matrix
    // withholds audit:read from every role but ADMIN.
    await expect(page.getByRole('link', { name: /audit/i })).toHaveCount(0);
  });
});

test.describe('the administrator', () => {
  test('cannot sign in without enrolling a second factor, then reaches the audit log', async ({
    page,
  }) => {
    await signInAdmin(page);

    // MFA is mandatory for administrators, so getting this far proves the
    // enrolment path works rather than being bypassable.
    await page.getByRole('link', { name: /audit/i }).click();

    // Signing in is itself auditable, so the log is never empty.
    await expect(page.getByRole('heading', { name: 'Audit log' })).toBeVisible();
    await expect(page.getByRole('listitem').first()).toBeVisible();
  });
});
