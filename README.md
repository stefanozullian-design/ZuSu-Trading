# ZuSu Trading

A day-trading automation platform built so that **AI can recommend a trade but can
never authorise one**. Every order passes a deterministic risk engine, every action
is auditable, and the system fails safe when a dependency disappears.

> **All nine phases complete.** Identity, portfolios, market data, the strategy
> builder and its promotion ladder, the backtest engine, paper trading, the
> analysis layer, the risk engine and scheduler, the live broker adapter with
> reconciliation, and the automation ladder. Every screen is reachable:
> **Market**, **Strategies**, **Backtest**, **Trading**, **Performance**,
> **Risk**, **Automation** and **Audit**.
>
> **Live trading is off, and automation ships at manual approval.**
> `ALLOW_LIVE_TRADING` is false; nothing automatic runs against a LIVE portfolio
> regardless of how it was promoted; and every seeded strategy sits at
> MANUAL_APPROVAL, where each order waits for a person. Raising a strategy onto
> an automatic rung takes an administrator, one rung at a time, a typed
> confirmation, and eight conditions that all pass — re-checked before every
> automatic order, not just at the moment of promotion. See
> [BUILD_STATUS.md](./BUILD_STATUS.md).

---

## Run it locally

You need Node 22+, PostgreSQL 16 and (optionally) Redis.

```bash
git clone <this repo> && cd ZuSu-Trading
npm install

npm run setup    # writes .env with generated secrets, then migrates, seeds and backfills
npm run dev      # API on :4000, web client on :5173
```

`npm run setup` refuses to touch an existing `.env`, so it is safe to re-run.

### Starting it without a terminal

Once setup has run, ZuSu can be started by double-clicking, which is how it is
meant to be used day to day:

| Platform      | Double-click     |
| ------------- | ---------------- |
| Windows       | `start-zusu.cmd` |
| macOS / Linux | `start-zusu.sh`  |

Run `install-desktop-icon.cmd` once on Windows to put a ZuSu icon on the
desktop; it creates a shortcut and nothing else, so deleting the icon undoes
it. `npm start` runs exactly the same thing from a terminal.

The launcher rebuilds the shared package, applies any migration that arrived
with a `git pull`, starts both halves, waits for each to answer, and opens a
browser. It stops on the first failure and explains it in plain words — a
database that is not running, a password that no longer matches, a port already
taken. The window it runs in is where errors appear; closing it stops ZuSu,
including the servers underneath, which `npm run dev` historically did not.

The `allowScripts` block in `package.json` pre-approves the four packages whose
install scripts npm 11 blocks by default — Prisma's engines and esbuild's
binary. Without it `npm install` reports success while leaving those unbuilt,
and the first failure arrives several commands later with an unrelated message.
Point `DATABASE_URL` at your PostgreSQL first if it is not the default
`postgresql://zusu:zusu@127.0.0.1:5432/zusu_trading`.

<details>
<summary>The same thing step by step, if you would rather see each part</summary>

```bash
cp .env.example .env
# Generate the three secrets and paste them into .env:
#   openssl rand -base64 48   # JWT_SECRET
#   openssl rand -base64 48   # COOKIE_SECRET
#   openssl rand -base64 32   # CREDENTIAL_ENCRYPTION_KEY

npm run build -w @zusu/shared   # the API and web client both import it
npm run db:generate             # Prisma client
npm run db:deploy               # apply migrations
npm run seed                    # demo users, portfolio, positions, strategies
npm run backfill:demo           # calendars, ~13,700 simulated candles, example scans
```

</details>

### Real market data

With a provider key in `.env` (`MARKET_DATA_PROVIDER=MASSIVE` and
`MASSIVE_API_KEY`), real bars are fetched with:

```bash
npm run sync:market                      # a year of daily bars, every symbol
npm run sync:market -- --days 30         # a shorter window
npm run sync:market -- --symbols AAPL,MSFT
npm run sync:market -- --timeframe 5m    # intraday, if the plan provides it
```

It paces itself to one request every twelve seconds, because a free plan allows
a handful a minute and a rate-limit refusal costs more than waiting does. Real
bars go through the same quality inspection as simulated ones and are tagged
with the provider that produced them, so nothing downstream can confuse the two.
The scheduler repeats a short sync every six hours; with no provider configured
it reports that and fetches nothing rather than generating anything.

An end-of-day plan returns nothing at all for an intraday timeframe, and the
script says so rather than leaving you looking for a bug.

`backfill:demo` is what makes the **Market** page show something. It generates
bars from the deterministic simulator and pushes them through the real quality
layer, so inspection, storage and the indicator engine all run the path they
will run on live data. Every row it writes is tagged `demo-simulator`, and the
page says so at the top — nothing here can be mistaken for a real feed.

Open <http://localhost:5173> and sign in with any seeded account:

| Email                | Password           | Role                                           |
| -------------------- | ------------------ | ---------------------------------------------- |
| `admin@zusu.local`   | `DemoTrading2026!` | ADMIN — prompted to enrol MFA on first sign-in |
| `manager@zusu.local` | `DemoTrading2026!` | MANAGER — can trade, cannot change risk limits |
| `client@zusu.local`  | `DemoTrading2026!` | CLIENT — read-only, one portfolio              |
| `viewer@zusu.local`  | `DemoTrading2026!` | VIEWER — limited read-only                     |

The whole application is explorable in DEMO mode with **no API credentials of any
kind**: market data comes from a deterministic simulator and orders would go to a
simulated venue.

### The Market and Scanner pages

`/market` is where Phase 2 is visible: a price chart with moving averages and a
Bollinger envelope, RSI and MACD panels, every indicator value as of the newest
bar, the market session and per-symbol tradability, and what the data-quality
layer currently thinks of the feed. An indicator without enough history shows as
`—  needs 50`, never as zero.

`/scanner` filters that universe. Conditions are ANDed, and a condition's
right-hand side can be a constant or another field, so "close above sma50" is
expressible. Symbols whose indicators are still in warm-up appear under
**Could not evaluate** rather than being dropped — so an empty result set can
be told apart from an unanswerable one. Filters can be saved and re-run;
`backfill:demo` seeds three examples.

### The Strategies page

`/strategies` is the no-code builder. A rule is assembled from selects —
nested **all of** / **any of** / **not** groups over the same conditions the
scanner uses — and it is data, never code: nothing entered there is ever
executed.

Three rules are visible on the page rather than buried in the schema:

- **A version cannot be edited.** There is no edit form, because the database
  refuses the update. Changing a rule adds a version, which starts back at
  DRAFT. The lineage is kept, so "what were we running in August" has an
  answer.
- **Promotion is one rung at a time**: DRAFT → BACKTEST → PAPER → REVIEW →
  APPROVED → LIVE. A version cannot be approved without a stop loss, the
  approval records who signed it, and going live is a separate step from being
  approved — so approved never silently means running. Authoring needs
  `strategy:write`, which a manager has; promoting needs `strategy:promote`,
  which stops at admin.
- **A signal is a recommendation.** Evaluating a version records signals at
  `CREATED` and stops. No route in this API can turn one into an order.

Evaluation accounts for every symbol it looked at: fired, rejected, already
signalled on this bar, or **could not be judged** with the reason — a rule that
cannot be evaluated returns unknown, and unknown is never permission to trade.

### Owners and what a portfolio is for

One person managing money for several people is the ordinary case rather than
an enterprise one: their own portfolios, a parent's, each split by what the
money is for. A portfolio records an **owner** (the person whose money it is,
which the API calls a client) and an **objective**.

Names are unique per owner, not per installation, so two people may each have a
"Retirement". The constraint is declared `NULLS NOT DISTINCT`, because
PostgreSQL otherwise treats every NULL as distinct and would have allowed any
number of unowned portfolios sharing a name — the collision the constraint
exists to prevent, through the back door.

The objective is not a label. It selects the limits a portfolio _starts_ under:

| Objective   | Daily loss | Trades/day | Max drawdown |
| ----------- | ---------- | ---------- | ------------ |
| Day trading | 2%         | 20         | 15%          |
| Growth      | 1.5%       | 6          | 12%          |
| Income      | 1%         | 3          | 10%          |
| Retirement  | 0.5%       | 2          | 8%           |

A single set of defaults meant one of those was always wrong. They remain a
starting point — the risk engine enforces what is stored, and an administrator
can change any of it afterwards. A portfolio with no stated objective keeps the
widest profile rather than being retroactively tightened, and the screen shows
`— not stated` rather than inventing one.

Assigning a portfolio to an owner is a manager's job; registering a new owner
needs `client:write`, which is administrator-only. Someone who could invent an
owner could quietly move a book to one.

### The Trading page

`/trading` is where the platform's premise is visible. A live strategy produces
recommendations; they sit in a queue until a person approves or rejects each
one. Approving sizes the order, runs the pre-trade checks and submits it to the
broker. Rejecting requires a reason.

There is no "approve all", no automatic sweep, and no setting that creates one.
Full automation is not a feature flag here — it is a thing this platform does
not have, and an end-to-end spec fails if such a control ever appears.

The page also shows positions with their **tax lots** — each opening fill keeps
its own cost basis and opening date, and a sale consumes lots oldest-first —
and orders with their fills, fees and slippage against the price the decision
was based on. A refused order is kept with its reason, so "why did this not
trade" always has an answer.

### The Performance page

`/performance` reports both return measures side by side:

- **Time-weighted** — how the strategy did, with external cash flows removed.
- **Money-weighted** — how this investor did, an internal rate of return over
  the dated flows.

They differ, sometimes by a lot, and showing only the flattering one is the
oldest trick in this business. A deposit is recorded as its own row and appears
under **net deposits**, never as a return: an account that grew because somebody
wired money in has returned nothing.

The trade journal is on the same page. An entry is written automatically when a
position opens, with the price and the signal that produced it; notes are
appended and never overwrite what was captured at entry, because a thesis edited
after the outcome is known stops being evidence.

### The Risk page

`/risk` sizes a proposed trade and checks it against the whole book. Sizing is
fixed-fractional: the number of shares follows from the distance to the stop, so
a wider stop buys fewer shares and the loss if the stop is hit is the same
fraction of equity either way. Without a stop it refuses rather than falling
back to a notional cap.

Every check shows its limit next to the actual value, so a refusal reads
"sector exposure exceeded: 42.76 against a limit of 30.00 percent of equity in
Technology" — something you can act on. A check that cannot be evaluated blocks:
an instrument with no sector recorded, or a symbol with too little history to
measure correlation, refuses rather than passing.

Breaches and near-misses are both recorded, because a pattern of near-misses is
what makes the eventual breach unsurprising.

### The scheduler

Six background jobs run inside the API: calendar sync, health persistence, order
polling, live-strategy evaluation, daily snapshots and the drawdown breaker.

Every one of them may stop trading and none may start any. The closest the
platform comes to automation is the evaluation job, which produces
recommendations that then wait for a person exactly as a hand-triggered one's
would. A test runs every job twice and asserts that no order exists afterwards.

The drawdown breaker halts a portfolio automatically when equity falls too far
from its peak, and nothing anywhere un-halts one: releasing is a person's
decision.

### Analysis

The Trading page can ask a model about a recommendation. What comes back is an
action, a confidence, a rationale and — the useful part — what would make it
wrong, shown on the card next to the Approve button.

It has no authority. The output schema has no quantity, no order type and no
execute flag, so a model cannot express an instruction to trade even if it
tries; an extra field it volunteers is stripped in parsing. A reply that does
not match the schema is stored as a failure with its raw text and contributes
nothing.

Spend is capped before a call, not reported after one: a daily dollar budget, an
hourly call ceiling and a per-call output cap. What has been spent today is on
the same page.

**This needs an `ANTHROPIC_API_KEY`, and this deployment does not have one.**
Without a key the page says so and every attempt is recorded as a refusal. It
will not substitute a plausible-looking opinion — a fabricated analysis is worse
than none, because you could not tell.

### The Backtests page

`/backtests` runs a strategy version over stored history. The design rule is
that a result never arrives without its assumptions, so the page shows, beside
every number:

- **How it was modelled.** A decision on a closed bar fills at the next bar's
  open. A stop fills at its own price unless the bar gapped through it, in which
  case it fills at the open — the worse price. A bar containing both the stop
  and the target resolves as the stop, because a bar is a summary and not a
  path.
- **What it cost.** Commission, half the spread and a slippage fraction are
  charged on every fill; the gross figure sits next to the net one. The cost
  inputs are editable so you can see what they cost, not so they can be
  switched off.
- **What qualifies it.** Ambiguous exits, gaps through a stop, bars that could
  not be judged, signals not acted on, positions still open at the end.
- **What it refuses to tell you.** Sharpe and Sortino are withheld below thirty
  observations, CAGR below a month, the profit factor when nothing lost. An
  unavailable statistic renders as `—`, never as zero.

Walk-forward splits the window into consecutive in-sample and out-of-sample
folds and recomputes indicators per fold, so no fold reads its own future.
Monte Carlo resamples the realised trades from a fixed seed — a statement about
sequence risk, not a forecast. Parameter search ranks candidates and reports the
reasons to doubt the ranking; it stores nothing and cannot write a version,
because choosing live rules from a search of the past is a person's decision.

To point the market pages at real data instead of the simulator, set
`MARKET_DATA_PROVIDER=MASSIVE` and `MASSIVE_API_KEY` in `.env`. Massive.com is
the former Polygon.io; its free tier is end-of-day only, so intraday needs a
paid plan.

API docs are at <http://localhost:4000/docs>.

### Tests

```bash
npm test              # 823 unit and integration tests
npm run test:e2e      # 71 Playwright specs against a real browser
```

The end-to-end suite manages its own database, API and web server. It migrates,
seeds and backfills through the same npm scripts listed above, so a broken setup
path fails the suite rather than surprising you later.

### With Docker

```bash
cp .env.example .env      # fill in the three secrets
docker compose up --build
docker compose exec api npx --workspace @zusu/api prisma migrate deploy
```

The web client is on <http://localhost:8080> and proxies `/api` to the API
container, so the browser sees a single origin.

## Commands

| Command                | What it does                                              |
| ---------------------- | --------------------------------------------------------- |
| `npm start`            | Everything, as the double-click launcher does it          |
| `npm run dev`          | API and web client in watch mode                          |
| `npm test`             | 153 tests across shared, API (unit + integration) and web |
| `npm run typecheck`    | TypeScript across all three packages                      |
| `npm run lint`         | ESLint, zero warnings tolerated                           |
| `npm run build`        | Production build of all three packages                    |
| `npm run db:migrate`   | Create and apply a migration in development               |
| `npm run db:reset`     | Drop, re-migrate and re-seed                              |
| `npm run docs:openapi` | Regenerate `docs/openapi.json` from the route schemas     |

Integration tests need a PostgreSQL database at
`postgresql://zusu:zusu@127.0.0.1:5432/zusu_trading_test` (override with
`TEST_DATABASE_URL`). They run the real migrations, so the database triggers and
constraints are exercised, not mocked.

## What is enforced, not just intended

- **AI never authorises a trade.** It produces a structured, schema-validated
  opinion that becomes one input to a deterministic risk decision.
- **The environment is unmistakable.** 🔵 DEMO / 🟡 PAPER / 🔴 LIVE is a full-width
  banner, and crossing environments is blocked by database triggers, the broker
  registry and the data model independently.
- **Live trading is off by default.** `ALLOW_LIVE_TRADING=false` blocks it even
  with a live portfolio and real credentials.
- **The audit log cannot be edited.** PostgreSQL refuses `UPDATE`, `DELETE` and
  `TRUNCATE` on it, and each row is hash-chained to its predecessor.
- **Clients cannot see each other.** One authorization choke point, and reaching
  another client's portfolio returns 404 (a 403 would confirm it exists) and is
  audited. Covered by isolation tests that drive the HTTP surface.
- **Orders are idempotent.** A crash immediately after submission cannot produce a
  second order.
- **Nothing pretends to work.** Services that are not built report `DISABLED` with
  the phase that delivers them; a value the backend could not compute renders as
  `—`, never as `0`; UI panels with no engine behind them say so.

## Documentation

| Document                                 | Contents                                                          |
| ---------------------------------------- | ----------------------------------------------------------------- |
| [ARCHITECTURE.md](./ARCHITECTURE.md)     | Execution pipeline, services, data model, security, failure modes |
| [BUILD_STATUS.md](./BUILD_STATUS.md)     | What is done, blocked, known-limited, and next                    |
| [ROADMAP.md](./ROADMAP.md)               | The nine phases and their exit criteria                           |
| [API.md](./API.md)                       | Endpoints, conventions and error codes                            |
| [docs/openapi.json](./docs/openapi.json) | Generated OpenAPI specification                                   |

## Security

Broker credentials are encrypted at rest with AES-256-GCM and never leave the API.
Passwords are scrypt-hashed. Administrators must use TOTP. Sessions are `httpOnly`
`SameSite=Lax` cookies with rotating refresh tokens and reuse detection, plus a
double-submit CSRF token. Secrets belong in environment variables locally and a
secrets manager in production — **never in this repository**.

## A note on scope

Trading involves substantial risk of loss. This software is a tool; it is not
investment advice, and labelling an operator "not an investment advisor" does not
by itself make an activity lawful. Anyone operating this system is responsible for
determining which regulatory framework applies to them, with qualified legal and
compliance advice. The platform provides configurable disclosures, consent records
and audit retention to support that; it does not assume any particular answer.
