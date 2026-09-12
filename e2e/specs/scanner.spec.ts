import { expect, test } from '@playwright/test';
import { signIn } from './helpers';

test.describe('the scanner', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, 'manager');
    await page.getByRole('link', { name: /scanner/i }).click();
  });

  test('runs the default filter and explains every match', async ({ page }) => {
    // Loosen the RSI bound so the filter matches; the seeded simulator's last
    // bar sits in the 60s, which the default 35 excludes.
    await page.getByLabel('Value').first().fill('95');
    await page.getByRole('button', { name: /run scan/i }).click();

    await expect(page.getByRole('heading', { name: /\d+ match(es)?/i })).toBeVisible();

    // A match must carry the values that produced it — a scanner that only
    // names a symbol cannot be checked.
    await expect(page.getByRole('columnheader', { name: 'close' })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'rsi14' })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'sma50' })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'AAPL', exact: true })).toBeVisible();
  });

  test('renders the filter back in words', async ({ page }) => {
    await page.getByRole('button', { name: /run scan/i }).click();
    await expect(page.getByText(/rsi14 below 35/)).toBeVisible();
    await expect(page.getByText(/close above sma50/)).toBeVisible();
  });

  test('separates "nothing matched" from "could not evaluate"', async ({ page }) => {
    // On daily bars there are only four sessions of history, so sma50 has no
    // value and the question cannot be asked of any symbol.
    await page.getByRole('button', { name: '1d', exact: true }).click();
    await page.getByRole('button', { name: /run scan/i }).click();

    await expect(page.getByRole('heading', { name: /could not evaluate/i })).toBeVisible();
    await expect(page.getByText(/were not a non-match/i)).toBeVisible();
    // The missing field is named, so the reason is actionable. Which field
    // it names depends on evaluation order — with four daily sessions both
    // rsi14 and sma50 are undefined — so assert the shape, not one name.
    await expect(page.getByText(/has no value at the latest bar/).first()).toBeVisible();

    // And the count reflects it: nothing was judged.
    await expect(page.getByText(/0 of \d+ evaluated/i)).toBeVisible();
  });

  test('adds a condition and applies it', async ({ page }) => {
    await page.getByRole('button', { name: /add condition/i }).click();

    const fields = page.getByLabel('Field', { exact: true });
    await expect(fields).toHaveCount(3);

    await page.getByRole('button', { name: /run scan/i }).click();
    await expect(page.getByRole('heading', { name: /\d+ match(es)?/i })).toBeVisible();
  });

  test('removes a condition', async ({ page }) => {
    await page.getByRole('button', { name: /remove condition 2/i }).click();
    await expect(page.getByLabel('Field', { exact: true })).toHaveCount(1);

    await page.getByRole('button', { name: /run scan/i }).click();
    // One condition left, so the run summary names only that one. Matched
    // exactly: the saved-scan sidebar prints both conditions together.
    await expect(page.getByText('rsi14 below 35', { exact: true })).toBeVisible();
  });

  test('compares a field to another field, not just to a number', async ({ page }) => {
    // The second seeded condition already does this; assert the control
    // reflects it, since field-to-field is what makes the scanner useful.
    const compareTo = page.getByLabel('Compare to').nth(1);
    await expect(compareTo).toHaveValue('field');
    await expect(page.getByLabel('Compared field')).toHaveValue('sma50');
  });

  test('scopes the universe to a watchlist', async ({ page }) => {
    // selectOption needs an exact label; the option prints its symbol count.
    await page.getByLabel(/universe/i).selectOption({ index: 1 });
    await page.getByRole('button', { name: /run scan/i }).click();

    await expect(page.getByText(/of 8 evaluated/i)).toBeVisible();
  });

  test('runs a seeded saved scan and records that it ran', async ({ page }) => {
    await expect(page.getByText('MACD turning up')).toBeVisible();
    await expect(page.getByText(/never run/).first()).toBeVisible();

    await page.getByRole('button', { name: 'MACD turning up', exact: true }).click();

    // The filter is loaded back into the builder, and the summary matches.
    await expect(page.getByText(/macd crosses above macdSignal/).first()).toBeVisible();
    await expect(page.getByText(/last run/).first()).toBeVisible();
  });

  test('saves a filter and lists it', async ({ page }) => {
    const name = `E2E scan ${String(Date.now())}`;
    await page.getByPlaceholder(/save this filter as/i).fill(name);
    await page.getByRole('button', { name: /^save$/i }).click();

    await expect(page.getByText(name)).toBeVisible();
  });

  test('refuses a threshold that is not a number, rather than reporting no data', async ({
    page,
  }) => {
    await page.getByLabel('Value').first().fill('not-a-number');
    await page.getByRole('button', { name: /run scan/i }).click();

    // A typo must read as a mistake the user can fix, not as "no symbol could
    // be evaluated" — which looks like missing market data. And the message
    // has to name the problem, not just refuse.
    await expect(page.getByText(/must be a number/i)).toBeVisible();
    await expect(page.getByRole('heading', { name: /could not evaluate/i })).toHaveCount(0);
  });

  test('a viewer can run a scan but cannot save one', async ({ page, context }) => {
    await page.getByRole('button', { name: /sign out/i }).click();
    await context.clearCookies();

    await signIn(page, 'viewer');
    await page.getByRole('link', { name: /scanner/i }).click();

    await page.getByRole('button', { name: /run scan/i }).click();
    await expect(page.getByRole('heading', { name: /\d+ match(es)?/i })).toBeVisible();

    // Running a scan changes nothing, so a viewer may; saving is config.
    await expect(page.getByPlaceholder(/save this filter as/i)).toHaveCount(0);
  });
});
