import { expect, test } from '@playwright/test';
import { signIn } from './helpers';

/**
 * Backtests, end to end.
 *
 * What these check is that a result never arrives without its assumptions: the
 * modelling rules, the costs, the window the bars actually covered, and the
 * counts that qualify the numbers. A backtest page that showed only a return
 * would be the most dangerous screen in the product.
 */

/** The seeded backfill covers four days, so the window is small and known. */
async function runBacktest(page: import('@playwright/test').Page): Promise<void> {
  await page.getByRole('link', { name: /backtests/i }).click();

  const today = new Date();
  const from = new Date(today.getTime() - 10 * 86_400_000);
  await page.getByLabel('From').fill(from.toISOString().slice(0, 10));
  await page.getByLabel('To').fill(today.toISOString().slice(0, 10));

  await Promise.all([
    page.waitForResponse(
      (r) => r.url().includes('/api/backtests') && r.request().method() === 'POST',
    ),
    page.getByRole('button', { name: /^Run$/ }).click(),
  ]);
}

test.describe('running a backtest', () => {
  test('reports a result together with how it was modelled', async ({ page }) => {
    await signIn(page, 'manager');
    await runBacktest(page);

    await expect(page.getByRole('heading', { name: /how this was modelled/i })).toBeVisible();
    // The two assumptions that matter most, on screen rather than in a doc.
    await expect(page.getByText(/next bar’s open, never at that bar’s close/)).toBeVisible();
    await expect(page.getByText(/gaps through it, which fills at the open/)).toBeVisible();
  });

  test('shows gross beside net, so the cost of trading is a number', async ({ page }) => {
    await signIn(page, 'manager');
    await runBacktest(page);

    await expect(page.getByText('Net profit')).toBeVisible();
    await expect(page.getByText('Gross profit')).toBeVisible();
    await expect(page.getByText(/fees,.*slippage/)).toBeVisible();
  });

  test('always shows what qualifies the result', async ({ page }) => {
    await signIn(page, 'manager');
    await runBacktest(page);

    // Present whether or not there is anything to report: an empty panel says
    // "nothing qualifies this", which is itself information.
    await expect(page.getByRole('heading', { name: /what qualifies this result/i })).toBeVisible();
  });

  test('names the window the bars actually covered', async ({ page }) => {
    await signIn(page, 'manager');
    await runBacktest(page);

    // The requested window is ten days; the seeded history is four. The page
    // says which one the result describes.
    await expect(page.getByText(/Bars actually read span/)).toBeVisible();
  });

  test('renders an unavailable statistic as a dash, never as zero', async ({ page }) => {
    await signIn(page, 'manager');
    await runBacktest(page);

    // CAGR is withheld under a month, and four days is under a month.
    const cagr = page.locator('div', { has: page.getByText('CAGR', { exact: true }) }).last();
    await expect(cagr).toContainText('—');
  });

  test('offers no control that turns a good backtest into a live strategy', async ({ page }) => {
    await signIn(page, 'manager');
    await runBacktest(page);

    // Promotion lives on the strategies page and needs a permission a manager
    // does not have. Nothing here shortcuts it.
    await expect(page.getByRole('button', { name: /go live|deploy|promote/i })).toHaveCount(0);
  });
});

test.describe('permissions', () => {
  test('a viewer cannot reach the page', async ({ page }) => {
    await signIn(page, 'viewer');
    await expect(page.getByRole('link', { name: /backtests/i })).toHaveCount(0);

    await page.goto('/backtests');
    await expect(page.getByRole('heading', { name: /open positions/i })).toBeVisible();
  });
});
