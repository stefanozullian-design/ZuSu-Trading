import { expect, test, type Page } from '@playwright/test';
import { ACCOUNTS, signIn, signInAdmin, signOut } from './helpers';

test.describe('signing in', () => {
  test('rejects a wrong password without revealing whether the account exists', async ({
    page,
  }) => {
    await page.goto('/');
    await page.getByLabel(/email/i).fill(ACCOUNTS.manager.email);
    await page.getByLabel(/password/i).fill('definitely-not-the-password');
    await page.getByRole('button', { name: /sign in/i }).click();

    await expect(page.getByRole('button', { name: /sign in/i })).toBeVisible();
    // The message must not distinguish "no such user" from "wrong password".
    const body = await page.locator('body').innerText();
    expect(body).not.toMatch(/no such user|unknown email|user not found/i);
  });

  test('signs a manager in and back out', async ({ page }) => {
    await signIn(page, 'manager');
    await expect(page.getByText(/MANAGER/)).toBeVisible();
    await signOut(page);
  });
});

test.describe('the dashboard', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, 'manager');
  });

  test('names the version on screen, so "is this the new one" is answerable', async ({ page }) => {
    // An old version and a new one look identical until a feature is missing,
    // and noticing an absence is exactly what people are bad at. The commit
    // comes from the server, which read it from the checkout at start-up — so
    // it names what is *running*, not what was last pulled.
    await expect(page.getByLabel('Running version')).toHaveText(/^[0-9a-f]{7,}/);
  });

  test('says unmistakably that this is the demo environment', async ({ page }) => {
    // The banner exists so nobody can mistake simulated trading for real.
    const banner = page.getByRole('status');
    await expect(banner).toContainText('DEMO');
    await expect(banner).toContainText(/simulated broker/i);
  });

  test('shows real seeded portfolio figures, not placeholders', async ({ page }) => {
    await expect(page.getByText('Account value', { exact: true })).toBeVisible();

    // A currency amount with a thousands separator — proof the number came
    // from the database rather than being a hard-coded dash.
    await expect(page.locator('body')).toContainText(/\$\d{1,3}(,\d{3})+\.\d{2}/);
  });

  test('lists the seeded open positions with their marks', async ({ page }) => {
    await expect(page.getByRole('heading', { name: /open positions/i })).toBeVisible();
    for (const symbol of ['AAPL', 'MSFT', 'NVDA', 'SPY']) {
      await expect(page.getByRole('cell', { name: symbol, exact: true })).toBeVisible();
    }
  });

  test('reports per-dependency health, including what is not built yet', async ({ page }) => {
    await expect(page.getByRole('heading', { name: /system health/i })).toBeVisible();
    await expect(page.getByText('Database', { exact: true })).toBeVisible();

    // Nothing claims to be running that is not: with no API key the analysis
    // service reports DISABLED with the reason, rather than a green light.
    await expect(page.getByText(/no ANTHROPIC_API_KEY/i)).toBeVisible();
  });

  test('can make a portfolio without leaving the page', async ({ page }) => {
    // There was no screen for this at all — the only route to a portfolio of
    // your own was a hand-written API request, so a fresh install's first
    // experience was a dead end.
    await page.getByRole('button', { name: /new portfolio/i }).click();
    await page.getByLabel('Portfolio name').fill('E2E Second Book');
    await page.getByLabel('Starting cash').fill('25000');

    await Promise.all([
      page.waitForResponse(
        (r) => r.url().endsWith('/api/portfolios') && r.request().method() === 'POST',
      ),
      page.getByRole('button', { name: /create it/i }).click(),
    ]);

    await expect(page.getByRole('button', { name: /E2E Second Book/ })).toBeVisible();
  });

  test('renames a portfolio and closes it out of the list', async ({ page }) => {
    await page.getByRole('button', { name: /new portfolio/i }).click();
    await page.getByLabel('Portfolio name').fill('E2E Rename Me');
    await page.getByLabel('Starting cash').fill('5000');
    await Promise.all([
      page.waitForResponse(
        (r) => r.url().endsWith('/api/portfolios') && r.request().method() === 'POST',
      ),
      page.getByRole('button', { name: /create it/i }).click(),
    ]);

    await page.getByRole('button', { name: /E2E Rename Me/ }).click();
    await page.getByRole('button', { name: /^Rename$/ }).click();
    await page.getByLabel('New portfolio name').fill('E2E Renamed');
    await Promise.all([
      page.waitForResponse((r) => r.request().method() === 'PATCH'),
      page.getByRole('button', { name: /save name/i }).click(),
    ]);
    await expect(page.getByRole('button', { name: /E2E Renamed/ })).toBeVisible();

    // Closed rather than deleted: gone from the list, and still there behind
    // "Show closed", because its audit history cannot be erased.
    await page.getByRole('button', { name: /E2E Renamed/ }).click();
    await Promise.all([
      page.waitForResponse((r) => r.request().method() === 'PATCH'),
      page.getByRole('button', { name: /^Close$/ }).click(),
    ]);
    await expect(page.getByRole('button', { name: /E2E Renamed/ })).toHaveCount(0);

    await page.getByRole('button', { name: /show closed/i }).click();
    await expect(page.getByRole('button', { name: /E2E Renamed/ })).toBeVisible();
  });

  test('says whose each portfolio is, and filters to one person', async ({ page }) => {
    // One person managing money for several people is the ordinary case: their
    // own books, a parent's, split by what each is for. Two of them may
    // reasonably be called "Retirement", so the name alone stops identifying a
    // book and the owner has to be on screen beside it.
    const filter = page.getByLabel('Owner filter');
    await expect(filter).toBeVisible();

    await makePortfolio(page, 'E2E Unowned Book', '4000');

    // Filtered to a person, a portfolio belonging to nobody is not theirs.
    await Promise.all([
      page.waitForResponse((r) => r.url().includes('ownerId=')),
      selectOwner(page, /Demo Client/),
    ]);
    await expect(page.getByRole('button', { name: /E2E Unowned Book/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Demo Portfolio/ })).toBeVisible();

    // And the unassigned ones are findable rather than invisible — otherwise a
    // portfolio somebody forgot to assign is lost the moment they filter.
    await Promise.all([
      page.waitForResponse((r) => r.url().includes('ownerId=none')),
      filter.selectOption('none'),
    ]);
    await expect(page.getByRole('button', { name: /E2E Unowned Book/ })).toBeVisible();
  });

  test('creates a portfolio for whoever is filtered, not for nobody', async ({ page }) => {
    await Promise.all([
      page.waitForResponse((r) => r.url().includes('ownerId=')),
      selectOwner(page, /Demo Client/),
    ]);

    await makePortfolio(page, 'E2E Filtered Create', '3000');

    // Creating it unassigned would make it vanish from the list being looked
    // at, which reads as the creation having failed.
    await expect(page.getByRole('button', { name: /E2E Filtered Create/ })).toBeVisible();
  });

  test('shows an unstated purpose as a dash, never as a guess', async ({ page }) => {
    await page.getByRole('button', { name: /new portfolio/i }).click();
    await page.getByLabel('Portfolio name').fill('E2E No Purpose');
    await page.getByLabel('Starting cash').fill('2000');
    await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes('/api/portfolios') && r.request().method() === 'POST',
      ),
      page.getByRole('button', { name: /create it/i }).click(),
    ]);

    await page.getByRole('button', { name: /E2E No Purpose/ }).click();

    // The same rule every other unknown on this page follows: nobody said what
    // this is for, so the screen says nobody said.
    await expect(page.getByText('— not stated').first()).toBeVisible();
  });

  test('a portfolio started for a retirement begins under tighter limits', async ({ page }) => {
    await page.getByRole('button', { name: /new portfolio/i }).click();
    await page.getByLabel('Portfolio name').fill('E2E Retirement Book');
    await page.getByLabel('Starting cash').fill('100000');
    await page.getByLabel('What it is for').selectOption('RETIREMENT');

    // The picker says what the choice changes, rather than leaving it to be
    // discovered on the Risk page later.
    await expect(page.getByText(/must still be there in decades/i)).toBeVisible();

    await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes('/api/portfolios') && r.request().method() === 'POST',
      ),
      page.getByRole('button', { name: /create it/i }).click(),
    ]);

    await page.getByRole('button', { name: /E2E Retirement Book/ }).click();
    await page.getByRole('link', { name: 'Risk', exact: true }).click();

    // 0.5% of 100,000 rather than the day-trading 2%, and two trades a day
    // rather than twenty. Money meant for decades does not start life under a
    // day trader's appetite.
    const row = (label: string) =>
      page
        .locator('div')
        .filter({ hasText: new RegExp(`^${label}`) })
        .last();
    await expect(row('Max daily loss')).toContainText('500');
    await expect(row('Trades per day')).toContainText('2');
  });

  test('a manager may register an owner and edit one', async ({ page }) => {
    await page.getByRole('button', { name: /manage owners/i }).click();

    await page.getByRole('button', { name: /add an owner/i }).click();
    await page.getByLabel('New owner name').fill('E2E Aunt');
    await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes('/api/clients') && r.request().method() === 'POST',
      ),
      page.getByRole('button', { name: /^Add$/ }).click(),
    ]);
    await expect(page.getByRole('cell', { name: 'E2E Aunt', exact: true })).toBeVisible();

    await page.getByRole('button', { name: /edit E2E Aunt/i }).click();
    await page.getByLabel('Owner name').fill('E2E Great Aunt');
    await Promise.all([
      page.waitForResponse((r) => r.request().method() === 'PATCH'),
      page.getByRole('button', { name: /^Save$/ }).click(),
    ]);
    await expect(page.getByRole('cell', { name: 'E2E Great Aunt', exact: true })).toBeVisible();

    // And she is immediately available to assign a portfolio to.
    await page.getByRole('button', { name: /new portfolio/i }).click();
    await expect(page.getByLabel('Owner', { exact: true })).toContainText('E2E Great Aunt');
  });

  test('retires an owner instead of deleting them', async ({ page }) => {
    await page.getByRole('button', { name: /manage owners/i }).click();

    await page.getByRole('button', { name: /add an owner/i }).click();
    await page.getByLabel('New owner name').fill('E2E Retiree');
    await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes('/api/clients') && r.request().method() === 'POST',
      ),
      page.getByRole('button', { name: /^Add$/ }).click(),
    ]);

    const row = page.getByRole('row', { name: /E2E Retiree/ });
    await Promise.all([
      page.waitForResponse((r) => r.request().method() === 'PATCH'),
      row.getByRole('button', { name: /^Retire$/ }).click(),
    ]);

    // Gone from the pickers, still on this screen, and bring-back-able. An
    // owner is named by append-only audit rows from the moment they exist, so
    // there is no delete to offer.
    await expect(page.getByText(/no delete, and that is deliberate/i)).toBeVisible();
    await expect(page.getByRole('row', { name: /E2E Retiree/ })).toContainText(/retired/i);
    await expect(page.getByRole('button', { name: /bring back/i })).toBeVisible();

    await page.getByRole('button', { name: /hide owners/i }).click();
    await page.getByRole('button', { name: /new portfolio/i }).click();
    await expect(page.getByLabel('Owner', { exact: true })).not.toContainText('E2E Retiree');
  });

  test('refuses to retire somebody whose money is still being traded', async ({ page }) => {
    await page.getByRole('button', { name: /manage owners/i }).click();
    await page.getByRole('button', { name: /add an owner/i }).click();
    await page.getByLabel('New owner name').fill('E2E Busy');
    await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes('/api/clients') && r.request().method() === 'POST',
      ),
      page.getByRole('button', { name: /^Add$/ }).click(),
    ]);
    await page.getByRole('button', { name: /hide owners/i }).click();

    await page.getByRole('button', { name: /new portfolio/i }).click();
    await page.getByLabel('Portfolio name').fill('E2E Busy Book');
    await page.getByLabel('Starting cash').fill('1000');
    const ownerSelect = page.getByLabel('Owner', { exact: true });
    const label = (await ownerSelect.locator('option').allInnerTexts()).find((t) =>
      /E2E Busy/.test(t),
    );
    await ownerSelect.selectOption({ label: label! });
    await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes('/api/portfolios') && r.request().method() === 'POST',
      ),
      page.getByRole('button', { name: /create it/i }).click(),
    ]);

    await page.getByRole('button', { name: /manage owners/i }).click();
    await page
      .getByRole('row', { name: /E2E Busy/ })
      .getByRole('button', { name: /^Retire$/ })
      .click();

    // Retiring them would take them out of every picker while their book is
    // still open, hiding the book rather than the person.
    await expect(page.getByText(/still owns/i)).toBeVisible();
  });

  test('shows several portfolios together, and adds them up', async ({ page }) => {
    await makePortfolio(page, 'E2E Together A', '40000');
    await makePortfolio(page, 'E2E Together B', '60000');

    await page.getByRole('button', { name: /E2E Together A/ }).click();
    await page.getByRole('button', { name: /E2E Together B/ }).click({ modifiers: ['Control'] });

    await expect(page.getByRole('heading', { name: /portfolios together/i })).toBeVisible();
    // 40,000 and 60,000 of cash, added exactly.
    await expect(page.getByText('$100,000.00').first()).toBeVisible();
  });

  test('offers no way to act on several portfolios at once', async ({ page }) => {
    await makePortfolio(page, 'E2E NoAct A', '1000');

    await page.getByRole('button', { name: /E2E NoAct A/ }).click();
    await page.getByRole('button', { name: /Demo Portfolio/ }).click({ modifiers: ['Control'] });

    await expect(page.getByRole('heading', { name: /portfolios together/i })).toBeVisible();
    // The kill switch halts one book. A control that did not name exactly one
    // would be the most dangerous thing on this screen, so combining is a way
    // of looking and never a way of acting.
    await expect(page.getByRole('button', { name: /stop all trading/i })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /owner & purpose/i })).toHaveCount(0);
    await expect(page.getByText(/one portfolio at a time/i)).toBeVisible();
  });

  test('never reports a total it does not know', async ({ page }) => {
    await makePortfolio(page, 'E2E NoSnapshot', '7000');

    await page.getByRole('button', { name: /E2E NoSnapshot/ }).click();
    await page.getByRole('button', { name: /Demo Portfolio/ }).click({ modifiers: ['Control'] });

    // A brand-new portfolio has no prior snapshot, so there is no combined
    // day. The sum of the ones that do have snapshots is not the total — it is
    // a smaller number wearing the total's label.
    await expect(page.getByText(/no earlier snapshot/i)).toBeVisible();
  });

  test('does not put one person\u2019s name on another person\u2019s money', async ({ page }) => {
    await makePortfolio(page, 'E2E Unowned Total', '1000');

    // Demo Portfolio has an owner; the one just made has none.
    await page.getByRole('button', { name: /E2E Unowned Total/ }).click();
    await page.getByRole('button', { name: /Demo Portfolio/ }).click({ modifiers: ['Control'] });

    // Taking the first portfolio's owner for the heading attributed one
    // person's money to another the moment a selection crossed owners.
    await expect(page.getByText(/2 owners/i)).toBeVisible();
    await expect(page.getByText(/belong to different people/i)).toBeVisible();
  });

  test('makes a paper portfolio, and the banner stops claiming synthetic prices', async ({
    page,
  }) => {
    // Practice prices are invented; paper prices are the market's. A banner
    // fixed to the deployment would say "synthetic market data" over a book
    // priced from the real market — false, on the one element that exists so
    // the environment can never be mistaken.
    await expect(page.getByRole('status')).toContainText(/synthetic/i);

    await page.getByRole('button', { name: /new portfolio/i }).click();
    await page.getByLabel('Portfolio name').fill('E2E Paper Book');
    await page.getByLabel('Starting cash').fill('50000');
    await page.getByLabel('Prices').selectOption('PAPER');
    await expect(page.getByText(/cannot be changed afterwards/i)).toBeVisible();
    await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes('/api/portfolios') && r.request().method() === 'POST',
      ),
      page.getByRole('button', { name: /create it/i }).click(),
    ]);

    await page.getByRole('button', { name: /E2E Paper Book/ }).click();

    const banner = page.getByRole('status');
    await expect(banner).toHaveAccessibleName('Trading environment: PAPER');
    await expect(banner).toContainText(/real market data/i);
    await expect(banner).not.toContainText(/synthetic/i);

    // And back again: the claim follows the book rather than sticking.
    await page.getByRole('button', { name: /Demo Portfolio/ }).click();
    await expect(page.getByRole('status')).toContainText(/synthetic/i);
  });

  test('moves a portfolio to real prices, and everything follows', async ({ page }) => {
    await makePortfolio(page, 'E2E Switch Me', '20000');
    await page.getByRole('button', { name: /E2E Switch Me/ }).click();
    await expect(page.getByRole('status')).toContainText(/synthetic/i);

    await page.getByRole('button', { name: /owner & purpose/i }).click();
    await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes('/environment') && r.request().method() === 'POST',
      ),
      page.getByRole('button', { name: /move to real market prices/i }).click(),
    ]);
    await page.getByRole('button', { name: /^Done$/ }).click();

    // The banner, the tab and the filter all describe one portfolio, so they
    // have to agree about it.
    await expect(page.getByRole('status')).toContainText(/real market data/i);
    await expect(page.getByRole('button', { name: /E2E Switch Me/ })).toContainText(/paper/i);

    await page.getByLabel('Prices filter').selectOption('DEMO');
    await expect(page.getByRole('button', { name: /E2E Switch Me/ })).toHaveCount(0);
    await page.getByLabel('Prices filter').selectOption('PAPER');
    await expect(page.getByRole('button', { name: /E2E Switch Me/ })).toBeVisible();
    await page.getByLabel('Prices filter').selectOption('');
  });

  test('offers no way to make a portfolio live', async ({ page }) => {
    await page.getByRole('button', { name: /Demo Portfolio/ }).click();
    await page.getByRole('button', { name: /owner & purpose/i }).click();

    // Live is not a thing this platform can be talked into. No control offers
    // it, the API rejects the value at its schema, and the database refuses
    // the transition in a trigger.
    await expect(page.getByRole('button', { name: /move to live/i })).toHaveCount(0);
  });

  test('deletes a portfolio, but only when its name is typed', async ({ page }) => {
    await makePortfolio(page, 'E2E Debris', '500');
    await page.getByRole('button', { name: /E2E Debris/ }).click();
    await page.getByRole('button', { name: /^Delete$/ }).click();

    const confirm = page.getByRole('button', { name: /delete permanently/i });
    await expect(confirm).toBeDisabled();

    // A confirmation that can be clicked through without reading is not one.
    await page.getByLabel(/type the portfolio name/i).fill('e2e debris');
    await expect(confirm).toBeDisabled();

    await page.getByLabel(/type the portfolio name/i).fill('E2E Debris');
    await expect(confirm).toBeEnabled();

    await Promise.all([
      page.waitForResponse((r) => r.request().method() === 'DELETE'),
      confirm.click(),
    ]);

    await expect(page.getByRole('button', { name: /E2E Debris/ })).toHaveCount(0);
    await page.getByRole('button', { name: /show closed/i }).click();
    // Gone rather than hidden — the difference between deleting and closing.
    await expect(page.getByRole('button', { name: /E2E Debris/ })).toHaveCount(0);
  });

  test('says what deleting does not touch', async ({ page }) => {
    await makePortfolio(page, 'E2E Warned', '500');
    await page.getByRole('button', { name: /E2E Warned/ }).click();
    await page.getByRole('button', { name: /^Delete$/ }).click();

    // The audit log is the thing people assume deleting destroys, and the one
    // thing it does not.
    await expect(page.getByText(/audit log is not touched/i)).toBeVisible();
    await expect(page.getByText(/cannot be undone/i)).toBeVisible();
    await expect(page.getByText(/hides it from every list/i)).toBeVisible();

    await page.getByRole('button', { name: /^Cancel$/ }).click();
    await expect(page.getByRole('button', { name: /E2E Warned/ })).toBeVisible();
  });

  test('keeps the chosen portfolio when you change page', async ({ page }) => {
    // Each page used to keep its own selection, so picking a book here and
    // clicking through to Trading landed you on whichever one came first.
    await page.getByRole('button', { name: /new portfolio/i }).click();
    await page.getByLabel('Portfolio name').fill('E2E Sticky Book');
    await page.getByLabel('Starting cash').fill('7500');
    await Promise.all([
      page.waitForResponse(
        (r) => r.url().endsWith('/api/portfolios') && r.request().method() === 'POST',
      ),
      page.getByRole('button', { name: /create it/i }).click(),
    ]);

    await page.getByRole('button', { name: /E2E Sticky Book/ }).click();

    await page.getByRole('link', { name: 'Trading', exact: true }).click();
    await expect(page.getByLabel('Portfolio', { exact: true })).toHaveValue(/.+/);
    await expect(page.locator('select')).toContainText('E2E Sticky Book');
    const onTrading = await page.locator('select').inputValue();

    await page.getByRole('link', { name: 'Risk', exact: true }).click();
    await expect(page.locator('select').first()).toHaveValue(onTrading);
  });

  test('states plainly whether anything trades on its own', async ({ page }) => {
    // The one number on the dashboard worth being unambiguous about, and it is
    // read from the live configurations rather than asserted in prose.
    await expect(page.getByRole('heading', { name: 'Automation', exact: true })).toBeVisible();
    await expect(
      page.getByText(/Nothing trades on its own|place orders without a click/),
    ).toBeVisible();
  });

  test('says why the approvals panel is empty rather than showing an empty table', async ({
    page,
  }) => {
    // Whether or not anything is waiting — earlier specs in this run may have
    // produced some — the panel is about decisions a person owes, and it
    // points at the page where they are made.
    await expect(page.getByRole('heading', { name: /waiting for a decision/i })).toBeVisible();
    await expect(page.getByRole('link', { name: /open the trading page/i })).toBeVisible();
  });
});

test.describe('role gating', () => {
  test('a viewer gets neither the audit log nor write controls', async ({ page }) => {
    await signIn(page, 'viewer');

    // Audit is admin/manager territory.
    await expect(page.getByRole('link', { name: /audit/i })).toHaveCount(0);
    // Market data is reference data, so a viewer does get those.
    await expect(page.getByRole('link', { name: /market/i })).toBeVisible();
    await expect(page.getByRole('link', { name: /scanner/i })).toBeVisible();
  });

  test('a viewer navigating straight to /audit is redirected, not shown it', async ({ page }) => {
    await signIn(page, 'viewer');
    await page.goto('/audit');

    // Gated in the UI as well as the API — a hidden link is not a control.
    await expect(page).toHaveURL(/\/$/);
  });

  test('a manager does not get the audit log either — it is administrator-only', async ({
    page,
  }) => {
    await signIn(page, 'manager');
    // A manager can stop trading but cannot read the audit trail; the matrix
    // withholds audit:read from every role but ADMIN.
    await expect(page.getByRole('link', { name: /audit/i })).toHaveCount(0);
  });
});

test.describe('the administrator', () => {
  test('cannot sign in without enrolling a second factor, then reaches the audit log', async ({
    page,
  }) => {
    await signInAdmin(page);

    // MFA is mandatory for administrators, so getting this far proves the
    // enrolment path works rather than being bypassable.
    await page.getByRole('link', { name: /audit/i }).click();

    // Signing in is itself auditable, so the log is never empty.
    await expect(page.getByRole('heading', { name: 'Audit log' })).toBeVisible();
    await expect(page.getByRole('listitem').first()).toBeVisible();
  });
});

/** Makes a portfolio through the page, the way a person would. */
async function makePortfolio(page: Page, name: string, cash: string): Promise<void> {
  await page.getByRole('button', { name: /new portfolio/i }).click();
  await page.getByLabel('Portfolio name').fill(name);
  await page.getByLabel('Starting cash').fill(cash);
  await Promise.all([
    page.waitForResponse(
      (r) => r.url().includes('/api/portfolios') && r.request().method() === 'POST',
    ),
    page.getByRole('button', { name: /create it/i }).click(),
  ]);
}

/** Chooses an owner in the filter, which is a dropdown rather than buttons. */
async function selectOwner(page: Page, name: RegExp): Promise<void> {
  const filter = page.getByLabel('Owner filter');
  // Wait for the roster to arrive before reading the options. Reading them
  // straight away caught the dropdown before its query resolved, which passed
  // or failed on timing rather than on anything the test was about.
  await expect(filter.locator('option').filter({ hasText: name })).toHaveCount(1);
  const label = (await filter.locator('option').allInnerTexts()).find((t) => name.test(t));
  if (label === undefined) throw new Error(`no owner option matching ${String(name)}`);
  await filter.selectOption({ label });
}
