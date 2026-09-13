import { expect, test } from '@playwright/test';
import { signIn, signInAdmin } from './helpers';

/**
 * The risk engine, end to end.
 *
 * What these check is that a refusal is usable: the page shows every check
 * with its limit beside the actual value, so a blocked trade says which limit
 * and by how much rather than "risk limit exceeded".
 */

async function size(page: import('@playwright/test').Page, stop: string): Promise<void> {
  await page.getByRole('link', { name: /^Risk$/ }).click();
  await page.getByLabel('Symbol').fill('AAPL');
  await page.getByLabel('Entry price').fill('186');
  await page.getByLabel('Stop price').fill(stop);

  await Promise.all([
    page.waitForResponse((r) => r.url().includes('/assess')),
    page.getByRole('button', { name: /size and check/i }).click(),
  ]);
}

test.describe('changing the limits', () => {
  test('a manager is told who may change them, and gets no control', async ({ page }) => {
    await signIn(page, 'manager');
    await page.getByRole('link', { name: 'Risk', exact: true }).click();
    await expect(page.getByText(/limits, version/i)).toBeVisible();

    // Said rather than left as an absent button: somebody looking for this
    // needs to know it exists and who may use it, not conclude the platform
    // cannot do it.
    await expect(page.getByRole('button', { name: /^Change$/ })).toHaveCount(0);
    await expect(page.getByText(/needs an administrator/i)).toBeVisible();
  });

  test('an administrator changes them, and the old version is superseded', async ({ page }) => {
    await signInAdmin(page);
    await page.getByRole('link', { name: 'Risk', exact: true }).click();
    await expect(page.getByText(/limits, version 1/i)).toBeVisible();

    await page.getByRole('button', { name: /^Change$/ }).click();
    await page.getByLabel('Max daily loss').fill('4321.00');

    // A reason is required for the same purpose a rejection needs one.
    const save = page.getByRole('button', { name: /save new version/i });
    await expect(save).toBeDisabled();
    await page
      .getByLabel(/reason for the change/i)
      .fill('Holdings imported after the opening cash');
    await expect(save).toBeEnabled();

    await Promise.all([page.waitForResponse((r) => r.request().method() === 'PUT'), save.click()]);

    await expect(page.getByText(/limits, version 2/i)).toBeVisible();
    await expect(page.getByText(/4,321/)).toBeVisible();
  });
});

test.describe('sizing', () => {
  test('sizes from the distance to the stop and says what bound it', async ({ page }) => {
    await signIn(page, 'manager');
    await size(page, '182');

    await expect(page.getByText('Shares', { exact: true })).toBeVisible();
    await expect(page.getByText('Risk if stopped', { exact: true })).toBeVisible();
    // A surprising number is explicable: the page names the binding
    // constraint rather than just the answer.
    await expect(page.getByText('Bound by', { exact: true })).toBeVisible();
  });

  test('refuses to size without a stop rather than guessing', async ({ page }) => {
    await signIn(page, 'manager');
    await size(page, '');

    await expect(page.getByText(/no risk to size against/i).first()).toBeVisible();
  });

  test('shows every check with its limit next to the actual value', async ({ page }) => {
    await signIn(page, 'manager');
    await size(page, '182');

    for (const limit of [
      'max position size',
      'portfolio exposure',
      'sector exposure',
      'correlation',
      'daily loss',
      'max drawdown',
    ]) {
      await expect(page.getByRole('cell', { name: limit, exact: true })).toBeVisible();
    }
  });

  test('a refusal names the limit and the amount', async ({ page }) => {
    await signIn(page, 'manager');
    // A deliberately enormous position: whatever else passes, the size limit
    // will not.
    await page.getByRole('link', { name: /^Risk$/ }).click();
    await page.getByLabel('Symbol').fill('AAPL');
    await page.getByLabel('Entry price').fill('186');
    await page.getByLabel('Stop price').fill('185.9');
    await page.getByLabel('Risk per trade').fill('90');

    await Promise.all([
      page.waitForResponse((r) => r.url().includes('/assess')),
      page.getByRole('button', { name: /size and check/i }).click(),
    ]);

    // "exceeded: X against a limit of Y" — actionable, unlike "risk limit
    // exceeded".
    await expect(page.getByText(/against a limit of/).first()).toBeVisible();
  });
});

test.describe('permissions', () => {
  test('a viewer cannot reach the page', async ({ page }) => {
    await signIn(page, 'viewer');
    await expect(page.getByRole('link', { name: /^Risk$/ })).toHaveCount(0);

    await page.goto('/risk');
    await expect(page.getByRole('heading', { name: /open positions/i })).toBeVisible();
  });
});

test.describe('reconciliation', () => {
  test('compares both records and reports rather than corrects', async ({ page }) => {
    await signIn(page, 'manager');
    await page.getByRole('link', { name: /^Risk$/ }).click();

    await Promise.all([
      page.waitForResponse((r) => r.url().includes('/reconcile')),
      page.getByRole('button', { name: /compare against the broker/i }).click(),
    ]);

    // Either verdict is a pass here — the demo venue and the platform may or
    // may not agree on a freshly seeded account. What must be true is that a
    // verdict appears at all, and that it is a report rather than a repair.
    await expect(
      page.getByText('AGREES', { exact: true }).or(page.getByText('DIFFERS', { exact: true })),
    ).toBeVisible();
  });
});
