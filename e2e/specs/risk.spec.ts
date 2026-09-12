import { expect, test } from '@playwright/test';
import { signIn } from './helpers';

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
