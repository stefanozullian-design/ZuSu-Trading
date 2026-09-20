import { expect, test } from '@playwright/test';
import { signIn } from './helpers';

/**
 * The Holdings page.
 *
 * It exists because the book-keeping is one sitting's work with a brokerage
 * statement open: see what is held, correct it, check the correction landed.
 * The specs here are about that loop closing — an entry that does not appear
 * in the history is indistinguishable from one that was lost, and the whole
 * point of the page is being able to trust the book.
 */

test.describe('holdings', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, 'manager');
    await page.getByRole('link', { name: 'Holdings', exact: true }).click();
  });

  test('gathers the whole book-keeping job on one page', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Open positions' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Record what you did' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Recorded history' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Shares you already own' })).toBeVisible();
  });

  test('says plainly that nothing here reaches a broker', async ({ page }) => {
    // The premise of the page. A form that takes a share count and a price
    // looks exactly like an order ticket, and the one thing it must never be
    // mistaken for is an instruction to buy something.
    await expect(page.getByText(/Nothing on this page reaches a broker/i)).toBeVisible();
  });

  test('records a deposit and shows it in the history', async ({ page }) => {
    await page.getByRole('button', { name: 'Deposit' }).click();
    await page.getByLabel('Amount').fill('1234.56');

    await Promise.all([
      page.waitForResponse(
        (r) => /\/api\/portfolios\/[^/]+\/trades$/.test(r.url()) && r.request().method() === 'POST',
      ),
      page.getByRole('button', { name: 'Record it' }).click(),
    ]);

    // The confirmation says what it did to the book, not merely that it
    // succeeded: a deposit raises what you own and never what you earned. The
    // amount is in the matcher because the type hint above the form says the
    // same sentence without it, and a locator that matches both would pass
    // whether or not anything was recorded.
    await expect(page.getByText(/1,?234\.56 paid in/i)).toBeVisible();
    // And the loop closes — the entry is in the history without a reload.
    await expect(page.getByText('Deposit').last()).toBeVisible();
  });

  test('drops the share fields when the entry is a cash one', async ({ page }) => {
    await expect(page.getByLabel('Shares')).toBeVisible();
    await page.getByRole('button', { name: 'Withdrawal' }).click();

    // The server refuses a withdrawal carrying a share count rather than
    // guessing, so the form must not be able to send one.
    await expect(page.getByLabel('Shares')).toHaveCount(0);
    await expect(page.getByLabel('Amount')).toBeVisible();
  });

  test('refuses a sale of something the book does not hold, and says why', async ({ page }) => {
    await page.getByRole('button', { name: 'Sell' }).click();
    await page.getByLabel('Symbol').fill('AAPL');
    await page.getByLabel('Shares').fill('999999');
    await page.getByLabel('Price per share').fill('100');
    await page.getByRole('button', { name: 'Record it' }).click();

    // Either refusal is correct and both name the book rather than a code:
    // nothing held at all, or less held than is being sold.
    await expect(page.getByText(/holds no AAPL|would open a short position/i)).toBeVisible();
  });
});
