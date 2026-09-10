# ZuSu Trading — Architecture

A day-trading automation platform in which **AI can recommend a trade but can never
authorise one**. Every order that will ever exist must pass a deterministic risk
engine, and the system is designed so the trading engine keeps failing safe when
Claude, the UI, the market-data provider or a broker connection goes away.

This document describes the architecture in full. What is actually **built today**
is tracked separately in [BUILD_STATUS.md](./BUILD_STATUS.md) — the sections below
mark each component with the phase that delivers it.

---

## 1. The execution pipeline

The single most important structure in the system. Nothing may short-circuit it.

```
Market Data ──► Strategy Engine ──► Signal ──► Risk Engine ──► Execution Policy
                      ▲                            │
                      │                            ▼
                AI Analysis                   Order Manager ──► Broker Adapter ──► Broker
              (advisory only)                      │                                  │
                                                   ▼                                  │
                                            Reconciliation ◄──────────────────────────┘
                                                   │
                                                   ▼
                                         Position ──► P&L
```

Three rules follow from this shape:

1. **The AI is an input, never an authority.** The AI analysis engine produces a
   structured opinion that becomes one field on a signal. The risk engine can and
   does reject a signal Claude was confident about. `confidence > 0.7` is not, on
   its own, permission to do anything.
2. **The risk engine is the last gate before a broker.** Every path that creates an
   order calls `TradingGate.assertCanTrade` plus (from Phase 7) the portfolio risk
   checks. There is no bypass, not even for a manual trade — a human approval is an
   _additional_ requirement, never a substitute.
3. **A broker HTTP 200 is not a fill.** Order state advances only on broker
   confirmation or reconciliation. `SUBMITTED` never becomes `FILLED` because a
   request succeeded.

## 2. Environments

Three environments, isolated from each other at every level.

|                       | DEMO 🔵             | PAPER 🟡        | LIVE 🔴       |
| --------------------- | ------------------- | --------------- | ------------- |
| Market data           | synthetic simulator | real provider   | real provider |
| Broker                | simulated venue     | simulated fills | real broker   |
| Money                 | none                | none            | real          |
| Confirmation to enter | no                  | no              | **yes**       |

Isolation is enforced in four independent places, so a single bug cannot cross the
boundary:

- **Data model.** A portfolio's `environment` is set at creation and a database
  trigger refuses to change it, ever.
- **Database triggers.** `broker_accounts` and `orders` must match their
  portfolio's environment, and an order may not be routed through a broker account
  from another environment. See `prisma/migrations/*_enforce_invariants`.
- **Broker registry.** `BrokerRegistry.forPortfolio` returns an adapter whose
  `environment` is asserted to equal the portfolio's, and refuses LIVE entirely
  while `ALLOW_LIVE_TRADING` is false.
- **UI.** A full-width banner names the environment on every screen. It is never a
  subtle chip.

## 3. Services

The backend is a set of small modules with explicit dependencies, wired in one
composition root (`apps/api/src/container.ts`). Nothing reaches for a global.

| Service              | Responsibility                                                                                 | Phase     |
| -------------------- | ---------------------------------------------------------------------------------------------- | --------- |
| Market Data          | quotes, OHLCV, trades, options chains, market status, corporate actions                        | 2         |
| Market Data Quality  | staleness, gaps, impossible spreads, jumps, duplicates → halts trading                         | 2         |
| Market Calendar      | sessions, holidays, early closes, halts, per-symbol availability, crypto 24/7                  | 2         |
| Indicator Engine     | SMA, EMA, RSI, MACD, Bollinger, ATR, VWAP, ADX, Stochastic, rel. volume, HV — computed locally | 2         |
| Scanner              | universe → liquidity/price/volatility filters → candidates                                     | 2         |
| Strategy Engine      | evaluates versioned JSON rule trees                                                            | 3         |
| Signal Engine        | signal lifecycle, deterministic dedupe keys                                                    | 3         |
| AI Analysis (Claude) | structured context in, schema-validated JSON out, cost-capped                                  | 6         |
| Market Regime        | trending / range-bound / volatility / risk-on-off classification                               | 6         |
| Risk Engine          | position sizing, portfolio limits, correlation, drawdown, kill switches                        | 7         |
| Order Management     | idempotent orders, partial fills, cancellation, state reconciliation                           | 8         |
| Broker Adapter       | `BrokerAdapter` interface; Demo, Paper and venue implementations                               | 1 / 5 / 8 |
| Position & P&L       | authoritative positions, realised/unrealised, fees, slippage, tax lots                         | 5 / 8     |
| Backtesting          | event-driven replay with no look-ahead, walk-forward, Monte Carlo                              | 4         |
| Reconciliation       | compares internal records against the broker; halts on mismatch                                | 8         |
| Notifications        | browser, push, email, SMS, Slack, Discord                                                      | 6         |
| Reporting            | daily / weekly / monthly / client reports, PDF-CSV-Excel export                                | later     |
| **Audit**            | append-only, hash-chained record of everything                                                 | **1**     |
| **Auth & RBAC**      | sessions, MFA, permissions, tenant isolation                                                   | **1**     |
| **Health**           | per-dependency probes and circuit breakers                                                     | **1**     |

## 4. Source of truth

Conflicting sources of truth are the root of most trading-system incidents, so
ownership is stated explicitly and reconciliation logic exists wherever two
sources can disagree.

| Fact                    | Owner                                 |
| ----------------------- | ------------------------------------- |
| Market price            | market-data provider                  |
| Order state             | broker, reconciled into the database  |
| Live position           | broker, reconciled into the database  |
| Portfolio configuration | database                              |
| Strategy definition     | database (immutable versioned record) |
| Historical performance  | database                              |
| AI reasoning            | `ai_analyses` record                  |

GitHub, where strategy synchronisation is enabled, is an export and
version-control mechanism only. **It is never the source of truth for live
trading state.**

## 5. Data model

PostgreSQL via Prisma. 44 tables; see `apps/api/prisma/schema.prisma`.

Principles:

- **Money is `Decimal(24,8)`.** Never a float, anywhere, including in transit —
  the API encodes decimals as strings.
- **Relationships are tables.** No `associated_portfolios: [1,2,3]` arrays;
  `Client ↔ ClientPortfolio ↔ Portfolio` and `User ↔ PortfolioAccess ↔ Portfolio`.
- **Lifecycles are enums plus event tables** (`signal_events`, `order_events`),
  never a boolean.
- **Invariants the schema language cannot express are database triggers and
  constraints**, not conventions:

  | Invariant                                           | Mechanism                                                                   |
  | --------------------------------------------------- | --------------------------------------------------------------------------- |
  | `audit_logs` is append-only                         | `BEFORE UPDATE/DELETE/TRUNCATE` trigger raising an exception, plus `REVOKE` |
  | Every audit row is hashed                           | `CHECK (length(hash) = 64)` + application hash chain                        |
  | Environments never cross                            | triggers on `broker_accounts` and `orders`                                  |
  | A portfolio's environment is immutable              | trigger on `portfolios`                                                     |
  | Strategy versions are immutable                     | trigger blocking definition/risk changes                                    |
  | `filled_qty` ≤ `requested_qty`, quantities positive | `CHECK` constraints                                                         |
  | One OPEN position per symbol per portfolio          | partial unique index                                                        |
  | One active risk-limit version per portfolio         | partial unique index                                                        |
  | An order is never submitted twice                   | `UNIQUE (idempotency_key)`                                                  |
  | A signal never fires twice for one event            | `UNIQUE (signal_key)`                                                       |

## 6. Authentication, authorization and tenancy

- **Sessions**: a short-lived HS256 access token (15 min) and an opaque refresh
  token (14 days), both in `httpOnly` `SameSite=Lax` cookies. Refresh tokens
  rotate on every use and are tracked as a _family_; presenting an already-rotated
  token is treated as theft — the whole family is revoked and the event audited.
- **Passwords**: scrypt (N=2^15, r=8, p=1), salted per user, stored as
  `scrypt$N$r$p$salt$hash`. Unknown accounts still pay the verification cost so
  timing does not distinguish them.
- **MFA**: TOTP, mandatory for `ADMIN` — the role that can change risk limits and
  release a kill switch. The seed is encrypted at rest with AES-256-GCM.
- **CSRF**: double-submit token, on top of `SameSite=Lax` cookies.
- **Authorization** asserts _permissions_, never role names, so adding a role
  cannot silently widen access. The matrix lives in `packages/shared/permissions.ts`
  and is unit-tested.
- **Tenant isolation** has exactly one choke point: `AccessControl`. Every
  portfolio-scoped read composes `portfolioScope()` into its `where` clause and
  every write calls `assertPortfolioAccess()`. Reaching another client's portfolio
  returns **404, not 403** — a 403 would confirm the resource exists — and the
  attempt is audited. This is covered by dedicated isolation tests that drive the
  HTTP surface, so a route that forgets to scope its query fails CI.

Roles:

|                          | ADMIN | MANAGER | CLIENT | VIEWER |
| ------------------------ | ----- | ------- | ------ | ------ |
| Read assigned portfolios | ✓     | ✓       | ✓      | ✓      |
| Trade / approve signals  | ✓     | ✓       | —      | —      |
| Change risk limits       | ✓     | —       | —      | —      |
| Engage kill switch       | ✓     | ✓       | —      | —      |
| **Release** kill switch  | ✓     | —       | —      | —      |
| Read audit log           | ✓     | —       | —      | —      |
| Broker credentials       | ✓     | —       | —      | —      |

## 7. Failure modes

Designed for, not discovered in production:

| Failure                                           | Behaviour                                                                          |
| ------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Broker unavailable                                | no new orders; existing orders reconciled when it returns                          |
| Market data unavailable or failing quality checks | no new trades                                                                      |
| Claude unavailable                                | rule-based strategies continue **only** if configured to run without AI            |
| Database unavailable                              | no new trades                                                                      |
| Redis unavailable                                 | no automated execution; read-only operation continues                              |
| Reconciliation mismatch                           | affected portfolio moves to `RECONCILIATION_ERROR`; trading blocked until resolved |
| Web UI unavailable                                | backend continues under its configured safety rules                                |
| Process restart mid-submission                    | the idempotency key prevents a duplicate order                                     |

Repeated failures open a **circuit breaker** per dependency (`lib/circuit-breaker.ts`)
so a struggling service is not buried in retries, and the health panel shows
`SERVICE DEGRADED` rather than hiding it.

## 8. Observability

Structured JSON logs with a redaction list as a last line of defence (code is
still expected never to log a secret). Every trade-related event carries a
`correlationId` that threads through market event → signal → risk check →
approval → order → fill → position → P&L, and the same id appears on WebSocket
envelopes and audit rows.

## 9. Frontend

React + TypeScript + Vite, Tailwind and shadcn-style components. It is a control
centre, not a CRUD app: state is unambiguous, risk is always visible, and the
kill switch is one click plus a typed reason.

Two rules shape it:

- **No finished UI in front of nothing.** Panels for capabilities that do not
  exist yet say so and name the phase that brings them, rather than rendering an
  empty table that reads as "nothing is happening".
- **A value the backend could not compute renders as `—`, never as `0`.** An
  unmarked position shows "unmarked"; a daily P&L with no prior snapshot shows a
  dash.

Mobile is a separate layout, not a shrunken desktop: P&L, positions, approvals,
risk and the kill switch, in that order.

## 10. Repository layout

```
packages/shared/     domain enums, permission matrix, state machines, zod
                     contracts, decimal helpers — shared by API and web
apps/api/            Fastify + Prisma
  src/config/        boot-time validated configuration
  src/lib/           crypto, logging, errors, circuit breaker, clients
  src/modules/       audit, auth, broker, clients, health, portfolios, rbac,
                     risk, ws — each a service plus its routes
  src/plugins/       security (helmet/CORS/cookies/rate limit/CSRF), auth,
                     error boundary
  prisma/            schema, migrations, seed
  test/              integration tests against a real PostgreSQL
apps/web/            React control centre
docs/openapi.json    generated from the same zod schemas the routes validate with
```
