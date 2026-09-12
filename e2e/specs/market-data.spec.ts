import { expect, test } from '@playwright/test';
import { signIn } from './helpers';

test.describe('the market page', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, 'manager');
    await page.getByRole('link', { name: /market/i }).click();
  });

  test('leads with where the prices came from', async ({ page }) => {
    // A page of prices that does not say its source is the most misleading
    // thing this app could show.
    await expect(page.getByText('SIMULATED DATA')).toBeVisible();
    await expect(page.getByText(/not a market feed/i)).toBeVisible();
  });

  test('draws the price chart with its overlays', async ({ page }) => {
    const chart = page.getByRole('img', { name: /close price with SMA 20/i });
    await expect(chart).toBeVisible();

    // Three line series plus the Bollinger band, each with a labelled legend
    // entry so identity is never colour alone.
    for (const label of ['Close', 'SMA 20', 'SMA 50', /Bollinger/]) {
      await expect(page.getByText(label).first()).toBeVisible();
    }

    // The close path must actually have geometry, not be an empty <path>.
    const pathLength = await chart
      .locator('path')
      .nth(1)
      .evaluate((node) => {
        return (node as SVGPathElement).getTotalLength();
      });
    expect(pathLength).toBeGreaterThan(100);
  });

  test('reports per-bar values on hover rather than only at the latest bar', async ({ page }) => {
    const chart = page.getByRole('img', { name: /close price with SMA 20/i });
    const box = await chart.boundingBox();
    expect(box).not.toBeNull();

    await page.mouse.move(box!.x + box!.width * 0.6, box!.y + box!.height * 0.5);

    // O/H/L/C for the hovered bar, which only the crosshair can produce.
    await expect(page.getByText(/O \d/).first()).toBeVisible();
    await expect(page.getByText(/UTC/).first()).toBeVisible();
  });

  test('renders RSI and MACD as separate panels, never on the price axis', async ({ page }) => {
    await expect(page.getByRole('img', { name: /RSI 14/i })).toBeVisible();
    await expect(page.getByRole('img', { name: /MACD/i })).toBeVisible();
  });

  test('shows an undefined indicator as a dash with what it needs, never as zero', async ({
    page,
  }) => {
    // Four days of daily bars cannot define a 50-period average. The whole
    // null-not-zero discipline is worthless if the UI renders it as 0.
    await page.getByRole('button', { name: '1d', exact: true }).click();
    await expect(page.getByText(/needs 50/)).toBeVisible();

    const row = page
      .locator('dl div')
      .filter({ has: page.getByText('SMA 50', { exact: true }) })
      .locator('dd');
    await expect(row).toContainText('—');
    await expect(row).not.toContainText(/\b0\.00\b/);
  });

  test('computes the indicators it does have enough data for', async ({ page }) => {
    await expect(page.getByText(/computed locally/i)).toBeVisible();

    // RSI is bounded, so a plausible value is a real check rather than a
    // check that something was printed. Scoped to the indicator list: "RSI 14"
    // is also the title of its own chart panel.
    const value = await page
      .locator('dl div')
      .filter({ has: page.getByText('RSI 14', { exact: true }) })
      .locator('dd')
      .innerText();

    const rsi = Number(value.replace(/[^\d.-]/g, ''));
    expect(rsi).toBeGreaterThanOrEqual(0);
    expect(rsi).toBeLessThanOrEqual(100);
  });

  test('answers whether the symbol is tradable right now, with a reason', async ({ page }) => {
    await expect(page.getByRole('heading', { name: /market session/i })).toBeVisible();

    // Either answer is correct depending on when this runs; what matters is
    // that a refusal always carries a reason. Awaited rather than read
    // immediately, since the verdict arrives in its own request.
    await expect(page.getByText(/is tradable now|cannot be traded now/)).toBeVisible();

    const body = await page.locator('main').innerText();
    if (/cannot be traded now/.test(body)) {
      expect(body).toMatch(/closed|halted|not tradable/i);
    }
  });

  test('shows the calendar as dated rows, with weekends closed', async ({ page }) => {
    await expect(page.getByText('Calendar', { exact: true })).toBeVisible();
    // Session boundaries come from stored rows, so a closed day is a row that
    // says closed rather than a gap in the table.
    await expect(page.getByText('closed').first()).toBeVisible();
  });

  test('reports the data-quality verdict', async ({ page }) => {
    await expect(page.getByRole('heading', { name: /data quality/i })).toBeVisible();
    // The backfill pushes bars through the real quality layer, so a clean
    // verdict here proves the pipeline ran rather than being bypassed.
    await expect(page.getByText('CLEAN', { exact: true })).toBeVisible();
  });

  test('switches symbol and reloads that symbol’s series', async ({ page }) => {
    await page.getByRole('button', { name: /NVDA/ }).click();
    await expect(page.getByText(/NVDA · 5M/i)).toBeVisible();
  });
});
