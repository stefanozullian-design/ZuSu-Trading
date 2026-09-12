# Build status

**Current phase: 2 — Market data. Started.**
**Live trading: not possible.** No route in this API can create an order, and
`ALLOW_LIVE_TRADING` defaults to false.

**Market-data provider: Massive.com** (the former Polygon.io, rebranded
2025-10-30). Chosen for full US-tape coverage, REST and WebSocket access, a real
corporate-actions feed and documented per-tier rate limits. Deployment scope is
single-user, so no data-redistribution licence is required.

Last updated: 2026-09-12

---

## Completed

### Phase 1 — Foundation

| Area                     | What exists                                                                                                                                                                                                                                                               |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Database**             | Full 44-table schema for the whole platform (all §58 entities), two migrations, invariants enforced by triggers, constraints and partial indexes                                                                                                                          |
| **Authentication**       | scrypt passwords, JWT access tokens, rotating refresh tokens with reuse detection, TOTP MFA mandatory for administrators, account lockout, CSRF, rate limiting                                                                                                            |
| **Authorization**        | Permission matrix (not role checks) enforced on the backend; single tenant-isolation choke point; cross-client access returns 404 and is audited                                                                                                                          |
| **Clients & portfolios** | Client records, portfolios bound permanently to an environment, conservative default risk limits derived from capital, positions with honest marking                                                                                                                      |
| **Broker abstraction**   | `BrokerAdapter` interface and a complete `DemoBroker`: deterministic price simulator, acknowledgement latency, partial fills against modelled liquidity, market/limit/stop/stop-limit, IOC/FOK/DAY, regulatory fees, cash and position ledger, Black-Scholes option chain |
| **Trading gate**         | The deterministic pre-order check (halt state, execution mode, environment, adapter availability, dependency health), evaluated and surfaced in the UI                                                                                                                    |
| **Kill switch**          | Halts one portfolio or every reachable one, cancels resting broker orders, leaves positions untouched, records a risk event; release is administrator-only                                                                                                                |
| **Audit**                | Append-only at the database level, tamper-evident hash chain, secret redaction, verification endpoint                                                                                                                                                                     |
| **Health**               | Live per-dependency probes with circuit breakers; unbuilt services report `DISABLED` with the phase that delivers them                                                                                                                                                    |
| **Real-time**            | WebSocket gateway with per-portfolio scoping and heartbeats                                                                                                                                                                                                               |
| **API docs**             | OpenAPI generated from the same zod schemas the routes validate against (`docs/openapi.json`, Swagger UI at `/docs`)                                                                                                                                                      |
| **Frontend**             | Login with MFA enrolment, dashboard (P&L, positions, risk monitor, kill switch, system health), audit view, mobile-specific layout, unmistakable environment banner                                                                                                       |
| **Demo mode**            | Seed data: four users covering every role, a client, a $100,000 demo portfolio with positions and snapshot history, a watchlist, three preconfigured strategy definitions. No API credentials needed                                                                      |
| **Infrastructure**       | Docker images for API and web, docker-compose stack, GitHub Actions running lint, format, typecheck, 186 tests, builds, a demo smoke test and `npm audit`                                                                                                                 |

### Test coverage

186 tests, all passing.

| Suite                  | Tests | Covers                                                                                                                                                                                                                                                                                                   |
| ---------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared`      | 22    | decimal money, order/signal state machines, permission matrix, environment rules                                                                                                                                                                                                                         |
| `apps/api` unit        | 94    | scrypt hashing, AES-256-GCM envelopes, circuit breaker, redaction and canonical JSON, market simulator determinism, Black-Scholes, demo broker (idempotency, partial fills, cancel races, buying power, fees), Massive.com adapter (null discipline, nanosecond clocks, pagination, splits, rate limits) |
| `apps/api` integration | 55    | login/MFA/refresh-rotation/reuse-detection/CSRF, client data isolation, RBAC, audit immutability and chain tampering, environment triggers, kill switch, portfolio accounting                                                                                                                            |
| `apps/web`             | 15    | formatting (never renders unknown as zero), environment banner, kill-switch permission gating                                                                                                                                                                                                            |

## In progress

### Phase 2 — Market data

| Step                            | State                                                                                                                                                                     |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Choose a provider            | Done — Massive.com. Free tier is end-of-day, Starter 15-minute delayed, real-time from Advanced. Options data needs Advanced.                                             |
| 2. `MarketDataProvider` adapter | Done — interface, `MassiveProvider` and the provider registry, with 33 unit tests against a fake transport. Not yet exercised against the live API; no key is configured. |
| 3. Data-quality layer           | Not started. Next.                                                                                                                                                        |
| 4. Market-calendar engine       | Not started. See the `getCalendar` limitation below.                                                                                                                      |
| 5. Indicator engine             | Not started.                                                                                                                                                              |
| 6. Watchlists, scanner, charts  | Not started.                                                                                                                                                              |
| 7. Playwright E2E suite         | Not started (scheduled for this phase).                                                                                                                                   |

The adapter deliberately does not persist anything yet. Quotes and candles are
returned as domain types; writing them to `market_data_quotes` and
`market_data_candles` belongs with the quality layer, so that nothing reaches the
database without having been checked first.

## Blocked

| Item                            | Blocked on                                                                                                                                                                                                                                                                           |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Live verification of the feed   | A Massive.com API key. The adapter is tested against a fake transport only; its behaviour against the real API — pagination volume, actual rate-limit headers, entitlement errors — is unverified until a key exists.                                                                |
| Live broker adapter (Phase 8)   | Confirmation of the broker's API capabilities — specifically whether it exposes client order IDs (needed for idempotency), execution-level fills (needed for partial fills and reconciliation), and defined-risk multi-leg option orders. Nothing about the venue should be assumed. |
| Options trading (Phase 8+)      | The same broker confirmation, plus greeks and open-interest availability.                                                                                                                                                                                                            |
| Notification delivery (Phase 6) | Choice of email/SMS/push providers.                                                                                                                                                                                                                                                  |

## Known limitations

These are deliberate and documented, not oversights:

1. **No order-placement endpoint exists.** Orders may only ever be created behind
   the risk engine (Phase 7) and order manager (Phase 8). Shipping a route that
   places orders now would mean shipping a path that bypasses risk checks.
2. **The demo broker's state lives in the process** and resets on restart. It is a
   simulator, deliberately kept separate from the application database so that
   reconciliation has two independent sources to compare.
3. **The demo market simulator's session logic is a US-equity approximation**
   (regular/pre/after/weekend in UTC). Holidays, early closes, trading halts and
   per-symbol availability are the market-calendar engine's job in Phase 2 and are
   not faked here.
4. **PAPER and LIVE portfolios are read-only.** Their broker adapters do not exist
   yet, and the registry refuses rather than substituting the demo broker.
5. **Positions in PAPER/LIVE portfolios show no mark price** because no market-data
   provider is configured. The API returns `null` rather than reusing the entry
   price as a stand-in.
6. **Daily P&L is null until a prior snapshot exists.** The snapshot writer is part
   of the portfolio-accounting work in Phase 5; the seed provides history for the
   demo portfolio so the dashboard can be evaluated.
7. **Seeded strategies are definitions only,** stored at stage `DRAFT`. No engine
   evaluates them until Phase 3.
8. **Tenant isolation is enforced in application code, not PostgreSQL RLS.** It
   runs through one choke point and is covered by isolation tests at the HTTP
   layer. Row-level security is a candidate hardening step once the connection
   model is settled.

## Technical debt

| Item                                         | Note                                                                                                                                                                                                                                                                                                   |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| No snapshot scheduler                        | `portfolio_snapshots` are written by the seed only; the daily writer belongs with the P&L engine (Phase 5).                                                                                                                                                                                            |
| Health checks are not persisted on a timer   | `HealthService.persist` exists but nothing calls it on a schedule; that arrives with the scheduler (Phase 7).                                                                                                                                                                                          |
| Container images build only in CI            | `docker build` cannot run in the development sandbox — its network policy blocks Docker Hub's blob CDN — so the two Dockerfiles are verified by CI's `docker` job rather than locally. Both images built successfully on the first run. Changes to either Dockerfile cannot be checked before pushing. |
| No E2E browser suite                         | The dashboard was verified with a scripted browser run during development, but Playwright specs are not yet committed. Worth adding before the UI grows.                                                                                                                                               |
| Rate limiting is per-process                 | Fine for a single instance; needs the Redis store before running more than one API replica.                                                                                                                                                                                                            |
| `apps/web` has no route-level code splitting | Irrelevant at this size; revisit when charting and backtesting views land.                                                                                                                                                                                                                             |

## Next steps

**Phase 2 — Market data.** Steps 1 and 2 are done; continue in order:

3. Build the market-data quality layer (staleness, gaps, impossible spreads,
   abnormal jumps, duplicates) and wire its verdict into `TradingGate` so failing
   data blocks new trades. This layer owns persistence: nothing reaches
   `market_data_quotes` or `market_data_candles` unchecked.
4. Build the market-calendar engine (regular/pre/after hours, holidays, early
   closes, halts, per-symbol availability, crypto 24/7) and replace the demo
   simulator's approximate session logic with it. Massive only reports upcoming
   holidays, so historical sessions need a second source or derivation from
   daily aggregates — see `MassiveProvider.getCalendar`.
5. Point `HealthService.checkMarketData` at the provider registry, so a
   configured feed is probed live instead of reporting `DISABLED`.
6. Build the indicator engine, computing locally rather than calling out.
7. Build watchlists, the scanner and charting.
8. Commit the Playwright end-to-end suite.

Do not start Phase 3 until Phase 2's tests pass.
