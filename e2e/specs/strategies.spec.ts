import { expect, test } from '@playwright/test';
import { ACCOUNTS, signIn, signInAdmin } from './helpers';

/**
 * The strategy builder, end to end.
 *
 * What these specs are really checking is that three promises survive all the
 * way to the screen: a rule is data a person assembles rather than code, a
 * version cannot be edited once written, and a signal stops at being a
 * recommendation.
 *
 * Nothing here asserts that a particular symbol fired. Whether a rule fires
 * depends on the market data the demo simulator happened to generate and on
 * what day the suite runs; a test that depends on either would be a test of
 * the calendar.
 */

/** Builds a nested rule — "all of [rsi below X, any of [...]]" — and saves it. */
async function buildDraft(page: import('@playwright/test').Page, name: string): Promise<void> {
  await page.getByLabel('Strategy name').fill(name);

  // Nest a group inside the root, so the saved definition is a tree rather
  // than the flat list the scanner uses.
  await page.getByRole('button', { name: /add group to entry rule 1/i }).click();
  const fields = page.getByLabel('Field', { exact: true });
  await fields.nth(1).selectOption('close');
  await page.getByLabel('Operator').nth(1).selectOption('gt');
  await page.getByLabel('Compare to').nth(1).selectOption('field');
  await page.getByLabel('Compared field').selectOption('sma50');

  await page.getByLabel('Change description').fill('First cut: oversold bounce with trend filter');
  await page.getByRole('button', { name: /save as draft/i }).click();
}

test.describe('authoring a strategy', () => {
  test('a manager builds a nested rule and reads it back in words', async ({ page }) => {
    await signIn(page, 'manager');
    await page.getByRole('link', { name: /strategies/i }).click();

    await buildDraft(page, 'E2E nested rule');

    // The rule comes back as a sentence, with the nesting preserved.
    await expect(
      page.getByText(/LONG when \(rsi14 below 30 and \(close above sma50\)\)/),
    ).toBeVisible();
    await expect(page.getByText('frozen').first()).toBeVisible();
  });

  test('a manager cannot promote what they just wrote', async ({ page }) => {
    await signIn(page, 'manager');
    await page.getByRole('link', { name: /strategies/i }).click();
    await buildDraft(page, 'E2E separation of duties');

    await expect(page.getByText(/DRAFT/).first()).toBeVisible();
    // Writing a rule and letting it run are different rights, and the UI
    // withholds the control rather than showing one that fails.
    await expect(page.getByRole('button', { name: /promote to/i })).toHaveCount(0);
  });

  test('a viewer cannot reach the page at all', async ({ page }) => {
    await signIn(page, 'viewer');
    await expect(page.getByRole('link', { name: /strategies/i })).toHaveCount(0);

    await page.goto('/strategies');
    // Redirected to the dashboard rather than shown an empty shell.
    await expect(page.getByRole('heading', { name: /open positions/i })).toBeVisible();
  });
});

test.describe('the promotion ladder', () => {
  test('an admin walks a version to live, one rung at a time', async ({ page }) => {
    await signInAdmin(page);
    await page.getByRole('link', { name: /strategies/i }).click();
    await buildDraft(page, 'E2E ladder');

    for (const stage of ['BACKTEST', 'PAPER', 'REVIEW', 'APPROVED']) {
      await page
        .getByRole('button', { name: new RegExp(`promote to ${stage}`, 'i') })
        .first()
        .click();
      await expect(page.getByLabel(`Stage ${stage}`).first()).toBeVisible();
    }

    // Approved is signed, and approved is not running.
    await expect(page.getByText(/^approved /i).first()).toBeVisible();
    await expect(page.getByRole('button', { name: /promote to LIVE/i }).first()).toBeVisible();

    await page
      .getByRole('button', { name: /promote to LIVE/i })
      .first()
      .click();
    await expect(page.getByLabel('Stage LIVE').first()).toBeVisible();
  });

  test('a rung cannot be skipped', async ({ page }) => {
    await signInAdmin(page);
    await page.getByRole('link', { name: /strategies/i }).click();
    await buildDraft(page, 'E2E no skipping');

    // The only promotion offered from DRAFT is the next one.
    const offered = await page.getByRole('button', { name: /promote to/i }).allInnerTexts();
    expect(offered.join(' ')).toContain('BACKTEST');
    expect(offered.join(' ')).not.toContain('LIVE');
  });
});

test.describe('evaluation stops at a recommendation', () => {
  test('a dry run reports its accounting and creates no order', async ({ page }) => {
    await signInAdmin(page);
    await page.getByRole('link', { name: /strategies/i }).click();
    await buildDraft(page, 'E2E evaluation accounting');

    await page.getByRole('button', { name: 'Dry run', exact: true }).first().click();

    // Whatever the market data says, the run accounts for itself: a
    // correlation id, and every symbol either fired, rejected, or named as
    // unjudgeable.
    await expect(page.getByRole('heading', { name: /evaluation/i })).toBeVisible();
    await expect(page.getByText(/correlation [0-9a-f-]{36}/)).toBeVisible();

    // Nothing on this page can place an order.
    await expect(page.getByRole('button', { name: /place|submit|buy|sell/i })).toHaveCount(0);
  });

  test('a signal recorded by a dry run appears as a recommendation only', async ({ page }) => {
    await signInAdmin(page);
    await page.getByRole('link', { name: /strategies/i }).click();
    await buildDraft(page, 'E2E signal status');

    await page.getByRole('button', { name: 'Dry run', exact: true }).first().click();
    await expect(page.getByRole('heading', { name: /evaluation/i })).toBeVisible();

    const created = page.getByText(/^fired /);
    if ((await created.count()) === 0) {
      // The simulator's latest bars did not satisfy the rule, or the market
      // has been closed long enough that the newest bar is not current. Both
      // are honest outcomes and both are stated on screen.
      await expect(
        page.getByText(/rule said no|too old to judge|could not be judged/).first(),
      ).toBeVisible();
      return;
    }

    // A recorded signal sits at CREATED. There is no control that advances it.
    await expect(page.getByText('CREATED').first()).toBeVisible();
    await expect(page.getByText(/a separate, human step/i)).toBeVisible();
  });
});

test.describe('accounts', () => {
  test('the seeded demo accounts are the ones documented', () => {
    // A guard on the fixtures these specs depend on, so a seed change that
    // renames an account fails here rather than in five unrelated specs.
    expect(ACCOUNTS.manager.email).toBe('manager@zusu.local');
    expect(ACCOUNTS.admin.email).toBe('admin@zusu.local');
  });
});
