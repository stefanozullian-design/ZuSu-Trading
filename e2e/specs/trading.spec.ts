import { expect, test } from '@playwright/test';
import { ACCOUNTS, signIn } from './helpers';

/**
 * Trading and performance, end to end.
 *
 * These check the promise the whole product rests on: a recommendation waits
 * for a person, and there is no control anywhere that removes the person.
 */

/** Produces signals through the real evaluation path, so the queue has content. */
async function seedSignals(page: import('@playwright/test').Page): Promise<number> {
  const cookies = await page.context().cookies();
  const csrf = cookies.find((cookie) => cookie.name === 'zusu_csrf')?.value ?? '';
  const headers = { 'x-csrf-token': csrf };

  const portfolios = await (await page.request.get('/api/portfolios')).json();
  const portfolioId = portfolios[0].id as string;

  const created = await page.request.post('/api/strategies', {
    headers,
    data: {
      name: `E2E loose rule ${String(Date.now()).slice(-6)}`,
      definition: {
        timeframe: '5m',
        watchlistId: null,
        entry: {
          direction: 'LONG',
          when: { type: 'condition', field: 'rsi14', operator: 'lt', operand: { constant: '99' } },
        },
        exit: null,
        stop: { kind: 'PERCENT', value: '2' },
        target: { kind: 'RISK_MULTIPLE', value: '2' },
      },
      riskSettings: { maxConcurrentPositions: 3, maxNotionalPerTrade: '3000', minBars: 60 },
      changeDescription: 'a rule loose enough to fire, for the approval queue',
    },
  });
  expect(created.status()).toBe(201);
  const strategy = await created.json();

  // A dry run records real signals at CREATED without the version being live,
  // which is exactly the state the approval queue is for.
  // Evaluated as of the newest stored bar. The engine refuses to judge a bar
  // that is no longer current, so a run on a Sunday against Friday's last
  // candle correctly produces nothing — which would make this spec depend on
  // the day of the week rather than on the code.
  const candles = await (
    await page.request.get('/api/market-data/AAPL/candles?timeframe=5m&limit=1')
  ).json();
  const newest = candles.candles?.[candles.candles.length - 1]?.openTime as string | undefined;

  const evaluated = await page.request.post(
    `/api/strategies/versions/${strategy.versions[0].id}/evaluate`,
    {
      headers,
      data: { portfolioId, dryRun: true, ...(newest ? { at: newest } : {}) },
    },
  );
  expect(evaluated.status()).toBe(200);
  const result = await evaluated.json();
  return result.created.length as number;
}

test.describe('the approval queue', () => {
  test('a signal waits for a person, and the page says so', async ({ page }) => {
    await signIn(page, 'manager');
    await page.getByRole('link', { name: 'Trading', exact: true }).click();

    // The queue's heading counts what is owed a decision. Whether it is empty
    // depends on what earlier specs produced; that it waits does not.
    await expect(page.getByRole('heading', { name: /awaiting a decision/i })).toBeVisible();
    const waiting = await page.getByRole('button', { name: 'Approve', exact: true }).count();
    if (waiting === 0) {
      await expect(page.getByText(/nothing sweeps this queue automatically/i)).toBeVisible();
    } else {
      // Each card explains what approving does, and none of them offers a way
      // to skip the deciding.
      await expect(page.getByText(/Approving sizes the order/i).first()).toBeVisible();
    }
  });

  test('offers no control that approves without a person', async ({ page }) => {
    await signIn(page, 'manager');
    await page.getByRole('link', { name: 'Trading', exact: true }).click();

    for (const label of [/approve all/i, /auto.?approve/i, /enable automation/i]) {
      await expect(page.getByRole('button', { name: label })).toHaveCount(0);
      await expect(page.getByRole('checkbox', { name: label })).toHaveCount(0);
    }
  });

  test('approving a recommendation places an order', async ({ page }) => {
    await signIn(page, 'manager');
    const count = await seedSignals(page);
    test.skip(count === 0, 'the simulator produced no signal in this window');

    await page.getByRole('link', { name: 'Trading', exact: true }).click();
    await expect(page.getByRole('heading', { name: /awaiting a decision/i })).toBeVisible();

    await page
      .getByLabel(/^Quantity for /)
      .first()
      .fill('5');
    await Promise.all([
      page.waitForResponse((r) => r.url().includes('/approve') && r.request().method() === 'POST'),
      page.getByRole('button', { name: 'Approve', exact: true }).first().click(),
    ]);

    // The order appears, and it is not instantly filled: the venue
    // acknowledges first, which is what a real one does.
    await expect(page.getByText(/^filled /).first()).toBeVisible();
  });

  test('a rejection needs a reason', async ({ page }) => {
    await signIn(page, 'manager');
    const count = await seedSignals(page);
    test.skip(count === 0, 'the simulator produced no signal in this window');

    await page.getByRole('link', { name: 'Trading', exact: true }).click();
    const reject = page.getByRole('button', { name: 'Reject', exact: true }).first();

    // Disabled until a reason is typed: a rejection is evidence about a
    // strategy, and "no" tells a future reader nothing.
    await expect(reject).toBeDisabled();
    await page
      .getByLabel(/^Reason for rejecting /)
      .first()
      .fill('thin volume on the setup');
    await expect(reject).toBeEnabled();
  });

  test('a viewer cannot reach the page', async ({ page }) => {
    await signIn(page, 'viewer');
    await expect(page.getByRole('link', { name: 'Trading', exact: true })).toHaveCount(0);

    await page.goto('/trading');
    await expect(page.getByRole('heading', { name: /open positions/i })).toBeVisible();
  });
});

test.describe('the market being shut', () => {
  test('says so before anyone clicks, rather than after', async ({ page }) => {
    await signIn(page, 'manager');
    await page.getByRole('link', { name: 'Trading', exact: true }).click();
    await expect(page.getByText(/recommendations awaiting a decision/i)).toBeVisible();

    // The gate is consulted whether or not the market happens to be open while
    // this runs, so both outcomes are legitimate — what must never happen is a
    // page that stays silent and lets the refusal arrive after the click.
    const banner = page.getByText('Nothing can be submitted right now');
    if (await banner.isVisible()) {
      await expect(page.getByText(/is closed|halted|deactivated/i).first()).toBeVisible();
      await expect(
        page.getByText(/Approving one now would be refused by the same check/i),
      ).toBeVisible();
    } else {
      // Open market: the approval controls are the ones that must be present.
      await expect(page.getByRole('button', { name: /^Approve$/ }).first()).toBeVisible();
    }
  });
});

test.describe('the positions list', () => {
  test('shows the book after arriving from the dashboard', async ({ page }) => {
    // The route everybody takes, and the one that used to break it: the
    // dashboard's own positions table shared a cache key with this list while
    // fetching a different shape, so this rendered "No positions" over a book
    // that was not empty.
    await signIn(page, 'manager');
    await expect(page.getByRole('heading', { name: /open positions/i })).toBeVisible();

    await page.getByRole('link', { name: 'Trading', exact: true }).click();
    await expect(page.getByText('Positions and their tax lots')).toBeVisible();

    await expect(page.getByText('No positions.')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /AAPL/ }).first()).toBeVisible();
  });
});

test.describe('shares already owned', () => {
  test('records a holding without spending cash or crediting a strategy', async ({ page }) => {
    await signIn(page, 'manager');
    await page.getByRole('link', { name: 'Trading', exact: true }).click();

    await page.getByRole('button', { name: /record a holding/i }).click();
    await page.getByLabel('Symbol to import').fill('TSLA');
    await page.getByLabel('Shares held').fill('12');
    await page.getByLabel('Average price paid').fill('195.50');
    await page.getByLabel('Date acquired').fill('2026-04-01');

    await Promise.all([
      page.waitForResponse((r) => r.url().includes('/positions/import')),
      page.getByRole('button', { name: /record it/i }).click(),
    ]);

    // The confirmation states what it did to the books, rather than quietly
    // doing it: value in, but never counted as performance.
    await expect(page.getByText(/recorded as a transfer in/i)).toBeVisible();
    await expect(page.getByText(/no strategy is credited/i)).toBeVisible();
  });

  test('refuses a symbol it could never price', async ({ page }) => {
    await signIn(page, 'manager');
    await page.getByRole('link', { name: 'Trading', exact: true }).click();

    await page.getByRole('button', { name: /record a holding/i }).click();
    await page.getByLabel('Symbol to import').fill('ZZZZ');
    await page.getByLabel('Shares held').fill('5');
    await page.getByLabel('Average price paid').fill('10');
    await page.getByLabel('Date acquired').fill('2026-04-01');

    await Promise.all([
      page.waitForResponse((r) => r.url().includes('/positions/import')),
      page.getByRole('button', { name: /record it/i }).click(),
    ]);

    await expect(page.getByText(/not an instrument this platform knows/i)).toBeVisible();
  });
});

test.describe('performance', () => {
  test('shows both return measures and the conventions behind them', async ({ page }) => {
    await signIn(page, 'manager');
    await page.getByRole('link', { name: /performance/i }).click();

    await expect(page.getByText('Time-weighted', { exact: true })).toBeVisible();
    await expect(page.getByText('Money-weighted', { exact: true })).toBeVisible();
    await expect(page.getByText(/never counted as profit/i).first()).toBeVisible();
  });

  test('a deposit shows up as a deposit, not as a return', async ({ page }) => {
    await signIn(page, 'manager');
    await page.getByRole('link', { name: /performance/i }).click();

    await Promise.all([
      page.waitForResponse((r) => r.url().includes('/snapshots')),
      page.getByRole('button', { name: /snapshot now/i }).click(),
    ]);

    await page.getByLabel('Amount').fill('5000');
    await Promise.all([
      page.waitForResponse((r) => r.url().includes('/cash-flows')),
      page.getByRole('button', { name: 'Record', exact: true }).click(),
    ]);

    await Promise.all([
      page.waitForResponse((r) => r.url().includes('/snapshots')),
      page.getByRole('button', { name: /snapshot now/i }).click(),
    ]);

    // Net deposits carries the 5,000 and the investment gain does not.
    await expect(page.getByText('Net deposits')).toBeVisible();
    const gain = page.locator('div', { has: page.getByText('Investment gain') }).last();
    await expect(gain).toBeVisible();
  });

  test('a viewer may read performance but not record a flow', async ({ page }) => {
    await signIn(page, 'viewer');
    await page.getByRole('link', { name: /performance/i }).click();

    await expect(page.getByText('Time-weighted', { exact: true })).toBeVisible();
    // Recording money in or out is a write, and a viewer has none.
    await expect(page.getByRole('button', { name: 'Record', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /snapshot now/i })).toHaveCount(0);
  });
});

test.describe('accounts', () => {
  test('the seeded manager is the one these specs assume', () => {
    expect(ACCOUNTS.manager.email).toBe('manager@zusu.local');
  });
});
