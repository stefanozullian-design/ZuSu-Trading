# Build status

**Current phase: 1 — Foundation. Complete.**
**Live trading: not possible.** No route in this API can create an order, and
`ALLOW_LIVE_TRADING` defaults to false.

Last updated: 2026-09-10

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
| **Infrastructure**       | Docker images for API and web, docker-compose stack, GitHub Actions running lint, format, typecheck, 153 tests, builds, a demo smoke test and `npm audit`                                                                                                                 |

### Test coverage

153 tests, all passing.

| Suite                  | Tests | Covers                                                                                                                                                                                                        |
| ---------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared`      | 22    | decimal money, order/signal state machines, permission matrix, environment rules                                                                                                                              |
| `apps/api` unit        | 61    | scrypt hashing, AES-256-GCM envelopes, circuit breaker, redaction and canonical JSON, market simulator determinism, Black-Scholes, demo broker (idempotency, partial fills, cancel races, buying power, fees) |
| `apps/api` integration | 55    | login/MFA/refresh-rotation/reuse-detection/CSRF, client data isolation, RBAC, audit immutability and chain tampering, environment triggers, kill switch, portfolio accounting                                 |
| `apps/web`             | 15    | formatting (never renders unknown as zero), environment banner, kill-switch permission gating                                                                                                                 |

## In progress

Nothing. Phase 1 is complete and Phase 2 has not started.

## Blocked

| Item                            | Blocked on                                                                                                                                                                                                                                                                           |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Real market data (Phase 2)      | Choice of provider. The provider adapter, quality layer and calendar cannot be finished until a provider's rate limits, session semantics and corporate-action feed are confirmed.                                                                                                   |
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

| Item                                         | Note                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| No snapshot scheduler                        | `portfolio_snapshots` are written by the seed only; the daily writer belongs with the P&L engine (Phase 5).                                                                                                                                                                                                                          |
| Health checks are not persisted on a timer   | `HealthService.persist` exists but nothing calls it on a schedule; that arrives with the scheduler (Phase 7).                                                                                                                                                                                                                        |
| Container images unverified locally          | `docker build` cannot run in the development sandbox — its network policy blocks Docker Hub's blob CDN — so the two Dockerfiles were written and their compose wiring validated (`docker compose config`), but not built end to end here. CI's `docker` job builds both on every push; treat the first CI run as their verification. |
| No E2E browser suite                         | The dashboard was verified with a scripted browser run during development, but Playwright specs are not yet committed. Worth adding before the UI grows.                                                                                                                                                                             |
| Rate limiting is per-process                 | Fine for a single instance; needs the Redis store before running more than one API replica.                                                                                                                                                                                                                                          |
| `apps/web` has no route-level code splitting | Irrelevant at this size; revisit when charting and backtesting views land.                                                                                                                                                                                                                                                           |

## Next steps

**Phase 2 — Market data.** In order:

1. Choose a market-data provider and confirm its rate limits, session semantics,
   historical depth and corporate-action feed.
2. Build the provider adapter behind a `MarketDataProvider` interface, mirroring
   how `BrokerAdapter` isolates the venue.
3. Build the market-data quality layer (staleness, gaps, impossible spreads,
   abnormal jumps, duplicates) and wire its verdict into `TradingGate` so failing
   data blocks new trades.
4. Build the market-calendar engine (regular/pre/after hours, holidays, early
   closes, halts, per-symbol availability, crypto 24/7) and replace the demo
   simulator's approximate session logic with it.
5. Build the indicator engine, computing locally rather than calling out.
6. Build watchlists, the scanner and charting.

Do not start Phase 3 until Phase 2's tests pass.
