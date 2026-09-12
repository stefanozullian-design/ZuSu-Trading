import { expect, test } from '@playwright/test';
import { signIn } from './helpers';

/**
 * The analysis layer, end to end.
 *
 * This deployment has no `ANTHROPIC_API_KEY`, so what these specs mostly check
 * is the behaviour of a platform that cannot run a model: it says so, it
 * records the refusal, and it does not invent an opinion. The absence of a key
 * is the normal state here, not a broken one.
 */

test.describe('without a provider', () => {
  test('says so on the page rather than showing an empty panel', async ({ page }) => {
    await signIn(page, 'manager');
    await page.getByRole('link', { name: 'Trading', exact: true }).click();

    await expect(page.getByRole('heading', { name: /analysis spend today/i })).toBeVisible();
    await expect(page.getByText(/no analysis provider is configured/i)).toBeVisible();
    // The reason matters as much as the fact.
    await expect(page.getByText(/a fabricated opinion is worse than none/i)).toBeVisible();
  });

  test('records a refusal instead of an answer, and the signal does not move', async ({ page }) => {
    await signIn(page, 'manager');

    const cookies = await page.context().cookies();
    const csrf = cookies.find((cookie) => cookie.name === 'zusu_csrf')?.value ?? '';
    const headers = { 'x-csrf-token': csrf };

    const portfolios = await (await page.request.get('/api/portfolios')).json();
    const portfolioId = portfolios[0].id as string;

    const created = await page.request.post('/api/strategies', {
      headers,
      data: {
        name: `E2E analysis ${String(Date.now()).slice(-6)}`,
        definition: {
          timeframe: '5m',
          watchlistId: null,
          entry: {
            direction: 'LONG',
            when: {
              type: 'condition',
              field: 'rsi14',
              operator: 'lt',
              operand: { constant: '99' },
            },
          },
          exit: null,
          stop: { kind: 'PERCENT', value: '2' },
          target: { kind: 'RISK_MULTIPLE', value: '2' },
        },
        riskSettings: { maxConcurrentPositions: 3, maxNotionalPerTrade: '3000', minBars: 60 },
        changeDescription: 'a rule loose enough to produce a signal to analyse',
      },
    });
    const strategy = await created.json();

    const candles = await (
      await page.request.get('/api/market-data/AAPL/candles?timeframe=5m&limit=1')
    ).json();
    const newest = candles.candles?.[0]?.openTime as string | undefined;

    const evaluated = await page.request.post(
      `/api/strategies/versions/${strategy.versions[0].id}/evaluate`,
      { headers, data: { portfolioId, dryRun: true, ...(newest ? { at: newest } : {}) } },
    );
    const signals = (await evaluated.json()).created as { id: string }[];
    test.skip(signals.length === 0, 'the simulator produced no signal in this window');
    const signalId = signals[0]!.id;

    const analysed = await page.request.post(`/api/analysis/signals/${signalId}`, { headers });
    expect(analysed.status()).toBe(200);
    const body = await analysed.json();

    // A refusal with a reason, and a row for it.
    expect(body.refusal).toContain('ANTHROPIC_API_KEY');
    expect(body.analysis.responseValid).toBe(false);
    expect(body.spend.providerConfigured).toBe(false);

    // And the recommendation is exactly where it was.
    const listed = await (
      await page.request.get(`/api/strategies/signals?portfolioId=${portfolioId}`)
    ).json();
    const signal = listed.signals.find((row: { id: string }) => row.id === signalId);
    expect(signal.status).toBe('CREATED');
  });
});

test.describe('notifications', () => {
  test('tells a person a recommendation is waiting, and can be dismissed', async ({ page }) => {
    await signIn(page, 'manager');

    const cookies = await page.context().cookies();
    const csrf = cookies.find((cookie) => cookie.name === 'zusu_csrf')?.value ?? '';
    const headers = { 'x-csrf-token': csrf };

    const portfolios = await (await page.request.get('/api/portfolios')).json();
    const created = await page.request.post('/api/strategies', {
      headers,
      data: {
        name: `E2E notify ${String(Date.now()).slice(-6)}`,
        definition: {
          timeframe: '5m',
          watchlistId: null,
          entry: {
            direction: 'LONG',
            when: {
              type: 'condition',
              field: 'rsi14',
              operator: 'lt',
              operand: { constant: '99' },
            },
          },
          exit: null,
          stop: { kind: 'PERCENT', value: '2' },
          target: { kind: 'RISK_MULTIPLE', value: '2' },
        },
        riskSettings: { maxConcurrentPositions: 3, maxNotionalPerTrade: '3000', minBars: 60 },
        changeDescription: 'a rule that produces something to be notified about',
      },
    });
    const strategy = await created.json();
    const candles = await (
      await page.request.get('/api/market-data/AAPL/candles?timeframe=5m&limit=1')
    ).json();
    const newest = candles.candles?.[0]?.openTime as string | undefined;
    const evaluated = await page.request.post(
      `/api/strategies/versions/${strategy.versions[0].id}/evaluate`,
      {
        headers,
        data: { portfolioId: portfolios[0].id, dryRun: true, ...(newest ? { at: newest } : {}) },
      },
    );
    const count = ((await evaluated.json()).created as unknown[]).length;
    test.skip(count === 0, 'the simulator produced no signal in this window');

    await page.getByRole('link', { name: 'Trading', exact: true }).click();
    await expect(page.getByText(/waiting for a decision/).first()).toBeVisible();

    const dismiss = page.getByRole('button', { name: /^Dismiss / }).first();
    await Promise.all([page.waitForResponse((r) => r.url().includes('/dismiss')), dismiss.click()]);
  });

  test('an anonymous caller gets nothing', async ({ page }) => {
    const response = await page.request.get('/api/notifications');
    expect(response.status()).toBe(401);
  });
});
