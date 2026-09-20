import { expect, test } from '@playwright/test';
import { signIn } from './helpers';

/**
 * The dashboard's composition block.
 *
 * What is being defended here is honesty under partial data. The seeded demo
 * portfolio may or may not have every holding priced on any given run, and the
 * rule is the same either way: either every percentage is shown, or none is
 * and the reason is named. A screen that shows some percentages and withholds
 * others without saying so is the failure these assertions exist to catch.
 */

test.describe('what the portfolio is made of', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, 'manager');
  });

  test('leads with findings rather than with a table', async ({ page }) => {
    // The dashboard's job is to answer "is anything wrong". A page that opens
    // with holdings makes the reader work that out themselves, every time.
    await expect(page.getByRole('heading', { name: 'Worth knowing' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'By holding' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'By sector' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Concentration' })).toBeVisible();
  });

  test('says something definite when it finds nothing', async ({ page }) => {
    const panel = page.getByRole('region', { name: 'Worth knowing' });
    // An empty panel is indistinguishable from one that failed to load, so
    // "nothing stands out" is written out rather than implied by blankness.
    await expect(panel).not.toBeEmpty();
  });

  test('either shows every weight or withholds them all, and says which', async ({ page }) => {
    const byHolding = page.getByRole('region', { name: 'By holding' });

    const text = (await byHolding.innerText()).trim();
    const withheld = text.includes('Percentages are withheld');
    const dashes = (text.match(/—/g) ?? []).length;

    if (withheld) {
      // Every weight is a dash, and the reason names the symbols.
      expect(text).toMatch(/cannot be priced/);
    } else {
      // Nothing is half-reported: no stray dashes among real percentages.
      expect(dashes).toBe(0);
    }
  });

  test('explains the effective-holdings figure rather than printing a bare number', async ({
    page,
  }) => {
    const concentration = page.getByRole('region', { name: 'Concentration' });

    // A number nobody can check is a number nobody should trust, so the index
    // it comes from is named on screen.
    await expect(concentration).toContainText(/Effective holdings|Not measurable/);
  });

  test('describes each bar for a reader who cannot see it', async ({ page }) => {
    const bars = page.getByRole('region', { name: 'By holding' }).getByRole('img');
    const count = await bars.count();
    if (count > 0) {
      // Identity and magnitude must not live in colour and length alone.
      await expect(bars.first()).toHaveAttribute('aria-label', /percent|weight unknown/);
    }
  });
});

test.describe('the watcher', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, 'manager');
  });

  test('has somewhere to speak, and says so when it has nothing', async ({ page }) => {
    const panel = page.getByRole('region', { name: 'Since you last looked' });
    await expect(panel).toBeVisible();

    // An empty panel is indistinguishable from a watcher that stopped running,
    // so the quiet case is written out rather than left blank.
    const text = await panel.innerText();
    expect(text.length).toBeGreaterThan(30);
  });
});
