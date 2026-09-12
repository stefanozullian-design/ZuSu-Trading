# ZuSu Trading

A day-trading automation platform built so that **AI can recommend a trade but can
never authorise one**. Every order passes a deterministic risk engine, every action
is auditable, and the system fails safe when a dependency disappears.

> **Phases 1 and 2 complete.** Identity, portfolios,
> the demo broker, the trading gate, the kill switch and the audit log work end
> to end. Market data adds the provider adapter, a data-quality layer, the market
> calendar and a local indicator engine, all visible on the **Market** page.
> **No route in this API can place an order** — orders may only ever be created
> behind the risk engine (Phase 7) and order manager (Phase 8). See
> [BUILD_STATUS.md](./BUILD_STATUS.md).

---

## Run it locally

You need Node 22+, PostgreSQL 16 and (optionally) Redis.

```bash
git clone <this repo> && cd ZuSu-Trading
npm install

cp .env.example .env
# Generate the three secrets and paste them into .env:
#   openssl rand -base64 48   # JWT_SECRET
#   openssl rand -base64 48   # COOKIE_SECRET
#   openssl rand -base64 32   # CREDENTIAL_ENCRYPTION_KEY
# and point DATABASE_URL at your PostgreSQL.

npm run build -w @zusu/shared   # the API and web client both import it
npm run db:generate             # Prisma client
npm run db:deploy               # apply migrations
npm run seed                    # demo users, portfolio, positions, strategies
npm run backfill:demo           # calendars, ~13,700 simulated candles, example scans

npm run dev                     # API on :4000, web client on :5173
```

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
npm test              # 649 unit and integration tests
npm run test:e2e      # 53 Playwright specs against a real browser
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
