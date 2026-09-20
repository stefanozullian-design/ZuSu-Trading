import { expect, test } from '@playwright/test';
import { signIn } from './helpers';

// Saved-scan names are unique in the database, and these specs save some. A
// run-scoped suffix keeps a re-run of this file alone from colliding with the
// scans its previous run left behind.
const RUN = String(Date.now()).slice(-6);

/**
 * Comparing saved scans.
 *
 * The view exists for one number — how many of the chosen filters flagged a
 * symbol — and the risk it carries is that the number reads as a verdict. So
 * the assertions are about the count being produced, and about the caveats
 * being on the page beside it rather than hidden in a tooltip.
 */

test.describe('comparing scans', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, 'manager');
    await page.getByRole('link', { name: /scanner/i }).click();
  });

  // These specs save scans, and the suite shares one database in a fixed
  // order. Scans left behind show up in every later spec's sidebar, where
  // their summaries collide with the assertions those specs make about their
  // own filter — which is exactly how this was found.
  test.afterEach(async ({ page }) => {
    const { scans } = await (await page.request.get('/api/market-data/scans')).json();
    for (const scan of scans as { id: string; name: string }[]) {
      if (scan.name.includes(RUN)) {
        await page.request.delete(`/api/market-data/scans/${scan.id}`);
      }
    }
  });

  test('offers the saved filters as columns to pick from', async ({ page }) => {
    const panel = page.getByRole('region', { name: 'Compare scans' });
    await expect(panel).toBeVisible();
    await expect(panel).toContainText(/Reading the lists one at a time cannot tell you that/);
  });

  test('lays two filters side by side and counts the agreement', async ({ page }) => {
    const panel = page.getByRole('region', { name: 'Compare scans' });

    // Save two filters so there is something to compare. The default condition
    // set matches nothing on the seeded data until the bound is loosened.
    await page.getByLabel('Value').first().fill('95');
    await page.getByLabel('Save this filter as').fill(`E2E Loose RSI ${RUN}`);
    await page.getByRole('button', { name: /^save$/i }).click();
    await expect(panel.getByRole('button', { name: `Compare E2E Loose RSI ${RUN}` })).toBeVisible();

    await page.getByLabel('Value').first().fill('99');
    await page.getByLabel('Save this filter as').fill(`E2E Looser RSI ${RUN}`);
    await page.getByRole('button', { name: /^save$/i }).click();
    await expect(
      panel.getByRole('button', { name: `Compare E2E Looser RSI ${RUN}` }),
    ).toBeVisible();

    await panel.getByRole('button', { name: `Compare E2E Loose RSI ${RUN}` }).click();
    await panel.getByRole('button', { name: `Compare E2E Looser RSI ${RUN}` }).click();
    await panel.getByRole('button', { name: /^Compare 2$/ }).click();

    // Both filters become columns, and the count column appears beside them.
    await expect(panel.getByRole('columnheader', { name: 'Flagged by' })).toBeVisible();
    await expect(panel.getByRole('columnheader', { name: `E2E Loose RSI ${RUN}` })).toBeVisible();
  });

  test('prints the caveats beside the count, not behind a tooltip', async ({ page }) => {
    const panel = page.getByRole('region', { name: 'Compare scans' });
    await page.getByLabel('Value').first().fill('95');
    await page.getByLabel('Save this filter as').fill(`E2E Caveat Check ${RUN}`);
    await page.getByRole('button', { name: /^save$/i }).click();

    await panel.getByRole('button', { name: `Compare E2E Caveat Check ${RUN}` }).click();
    await panel.getByRole('button', { name: /^Compare 1$/ }).click();

    // A number in a column headed with a tick will be read as a verdict unless
    // something on the page says otherwise.
    await expect(panel).toContainText(/not a score, and it is not advice/i);
    await expect(panel).toContainText(/one opinion stated three times/i);
  });
});
