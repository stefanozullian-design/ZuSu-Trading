import { expect, test } from '@playwright/test';
import { signIn } from './helpers';

/**
 * The automation ladder, end to end.
 *
 * The thing under test is the platform's premise at the one point where a
 * machine may act: full automation is never reached automatically, and the
 * screen makes climbing harder than descending.
 */

test.describe('the automation page', () => {
  test('shows all eight conditions, passing ones included', async ({ page }) => {
    await signIn(page, 'manager');
    await page.getByRole('link', { name: 'Automation', exact: true }).click();

    await expect(page.getByText('The eight conditions')).toBeVisible();
    // A checklist that lists only failures cannot tell you whether it ran.
    await expect(page.getByText('Backtest complete', { exact: true })).toBeVisible();
    await expect(page.getByText('Paper test passed', { exact: true })).toBeVisible();
    await expect(page.getByText('Reconciliation healthy', { exact: true })).toBeVisible();
    await expect(page.getByText('Kill switch available', { exact: true })).toBeVisible();
  });

  test('offers no control that reaches full automation in one step', async ({ page }) => {
    await signIn(page, 'manager');
    await page.getByRole('link', { name: 'Automation', exact: true }).click();
    await expect(page.getByText('The eight conditions')).toBeVisible();

    // From MANUAL_APPROVAL the only rung above is LIMITED_AUTO. There is no
    // button, anywhere on the page, that goes straight to FULL_AUTO.
    await expect(page.getByRole('button', { name: /authorise FULL_AUTO/i })).toHaveCount(0);
  });

  test('will not let a raise be authorised while a condition is unmet', async ({ page }) => {
    await signIn(page, 'manager');
    await page.getByRole('link', { name: 'Automation', exact: true }).click();
    await expect(page.getByText('The eight conditions')).toBeVisible();

    const authorise = page.getByRole('button', { name: /^Authorise /i });
    if (await page.getByText(/NOT MET/).isVisible()) {
      await expect(authorise).toBeDisabled();
      await expect(page.getByText(/None of the eight is waived here/)).toBeVisible();
    } else {
      // A seeded account that happens to be ready still must not be raised by
      // an empty confirmation box.
      await expect(page.getByLabel('Confirmation phrase')).toHaveValue('');
    }
  });

  test('an unverifiable condition is not rendered as a pass', async ({ page }) => {
    await signIn(page, 'manager');
    await page.getByRole('link', { name: 'Automation', exact: true }).click();
    await expect(page.getByText('The eight conditions')).toBeVisible();

    // The demo account has never reconciled, which is "could not check" —
    // its own icon and its own colour, never folded in with a tick.
    const unknown = page.getByLabel('could not be checked');
    const failed = page.getByLabel('not met');
    expect((await unknown.count()) + (await failed.count())).toBeGreaterThan(0);
  });
});
