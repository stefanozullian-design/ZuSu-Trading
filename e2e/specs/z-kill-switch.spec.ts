import { PrismaClient } from '@prisma/client';
import { expect, test } from '@playwright/test';
import { signIn } from './helpers';

/**
 * The kill switch, end to end.
 *
 * Named to sort last: engaging it halts the only seeded portfolio, which every
 * other spec's dashboard would then show as halted. State is restored in
 * `afterAll` through the database rather than the UI, because release requires
 * `kill_switch:release` and the administrator account is forced through MFA
 * enrolment on first sign-in — a separate journey, not a cleanup step.
 */

const db = new PrismaClient({
  datasources: {
    db: {
      url:
        process.env.E2E_DATABASE_URL ??
        'postgresql://zusu:zusu@127.0.0.1:5432/zusu_trading_e2e?schema=public',
    },
  },
});

test.afterAll(async () => {
  await db.portfolio.updateMany({
    data: { tradingState: 'ACTIVE', haltedReason: null, haltedAt: null },
  });
  await db.$disconnect();
});

test.describe.serial('the kill switch', () => {
  test('refuses to fire without a recorded reason', async ({ page }) => {
    await signIn(page, 'manager');
    await expect(page.getByText(/trading permitted/i)).toBeVisible();

    await page.getByRole('button', { name: /stop all trading/i }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    // The reason goes in the audit log, so it is not optional — the confirm
    // button stays disabled until one is given.
    const confirm = dialog.getByRole('button', { name: /stop all trading/i });
    await expect(confirm).toBeDisabled();

    await dialog.getByLabel(/reason/i).fill('E2E');
    await expect(confirm).toBeEnabled();

    await dialog.getByRole('button', { name: /cancel/i }).click();
    await expect(page.getByText(/trading permitted/i)).toBeVisible();
  });

  test('halts trading, and the gate says so', async ({ page }) => {
    await signIn(page, 'manager');

    await page.getByRole('button', { name: /stop all trading/i }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel(/reason/i).fill('E2E kill-switch check');
    await dialog.getByRole('button', { name: /stop all trading/i }).click();

    await expect(page.getByText(/trading is halted/i).first()).toBeVisible();
    await expect(page.getByText(/trading permitted/i)).toHaveCount(0);
    // The reason given is surfaced, not swallowed.
    await expect(page.getByText(/E2E kill-switch check/)).toBeVisible();
  });

  test('the halt is state, so it survives a reload', async ({ page }) => {
    await signIn(page, 'manager');
    await page.reload();
    await expect(page.getByText(/trading is halted/i).first()).toBeVisible();
  });

  test('a manager is told an administrator must release it, and gets no button', async ({
    page,
  }) => {
    await signIn(page, 'manager');

    // Anyone may stop trading; only an administrator may resume it.
    await expect(page.getByText(/an administrator must release it/i)).toBeVisible();
    await expect(page.getByRole('button', { name: /resume trading/i })).toHaveCount(0);
  });

  test('the API refuses a manager’s resume, not just the UI', async ({ page }) => {
    await signIn(page, 'manager');

    const listed = await page.request.get('/api/portfolios');
    expect(listed.ok()).toBe(true);
    const portfolios = (await listed.json()) as { id: string }[];
    const portfolioId = portfolios[0]?.id;
    expect(portfolioId).toBeTruthy();

    // A hidden button is not a control. The permission is enforced server-side.
    const resume = await page.request.post(`/api/risk/portfolios/${String(portfolioId)}/resume`, {
      data: { reason: 'trying it anyway' },
    });
    expect(resume.status()).toBe(403);
  });

  test('positions are untouched by a halt', async ({ page }) => {
    await signIn(page, 'manager');
    // A halt blocks new entries; it does not liquidate. The seeded positions
    // must still be listed.
    for (const symbol of ['AAPL', 'MSFT']) {
      await expect(page.getByRole('cell', { name: symbol, exact: true })).toBeVisible();
    }
  });
});
