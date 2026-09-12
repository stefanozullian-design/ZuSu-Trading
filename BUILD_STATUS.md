# Build status

**Current phase: 2 — Market data. Complete.** Phase 3 (strategies) is next.
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
| **Database**             | Full 46-table schema for the whole platform (all §58 entities plus `trading_halts` and `scan_definitions`), four migrations, invariants enforced by triggers, constraints and partial indexes                                                                             |
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
| **Infrastructure**       | Docker images for API and web, docker-compose stack, GitHub Actions running lint, format, typecheck, 487 tests, the end-to-end suite, builds, a demo smoke test and `npm audit`                                                                                           |

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

`MarketDataQualityService` is the only path by which market data reaches the
database, so `market_data_quotes` and `market_data_candles` cannot hold a row the
platform knows to be wrong. A rejected quote is not stored at all — not even
flagged as stale — because a price judged unusable must not sit anywhere
something could read it. A candle series is partially salvageable: impossible
bars are recorded and dropped, the rest stored, and the batch reported as not
accepted.

Blocking verdicts reach `TradingGate`, which distinguishes a feed-wide fault (a
dead provider blocks every non-DEMO portfolio) from a per-symbol fault (a warning
on the portfolio, blocking only for an order naming that symbol). DEMO
portfolios are exempt: the simulator prices them, not the provider.

**The Market page (`/market`) is where all of this became visible.** Phase 2 had
been five commits of machinery with no way to look at it, which left no feedback
loop at all. Read-only routes now expose instruments, candles, per-bar indicator
series, the latest indicator snapshot, per-symbol tradability, the data-quality
verdict and the calendar; the page renders them. `DemoFeed` backfills bars from
the deterministic simulator through the **real** quality layer, so the pipeline
is observable without a provider key — every row tagged `demo-simulator`, and
the page says so in a banner rather than implying a live feed.

**The scanner** evaluates a flat list of ANDed conditions over the newest bar.
Flat rather than a nested boolean tree on purpose: an AND/OR/NOT rule tree is
the strategy engine's job in Phase 3, and a second, subtly different expression
language here would guarantee the two disagree. A condition's right-hand side
may be a constant or another field, which is what makes it worth having —
"close above its 50-period average" is a more useful question than "close above
184". `crosses_above` compares two adjacent bars, so it means a change of side
rather than merely being on one side now.

Its defining behaviour is that **a null never matches and is never silently
dropped**. A symbol whose indicator is still in warm-up is reported under
`notEvaluable` with the field that was missing, so "nothing matched" can be told
apart from "the question could not be asked". Every match carries the values
that produced it, so a result can be checked by hand rather than trusted.

`indicators.ts` computes SMA, EMA, RSI, MACD, Bollinger Bands, ATR, VWAP, the
stochastic oscillator and OBV locally in decimal, never fetched from a provider.
Three invariants the tests check rather than assume: results are aligned 1:1
with their input, warm-up is null rather than zero, and `result[i]` depends only
on inputs at or before `i`. That last one has a proof per indicator — computing
over every prefix must agree with computing over the whole series and
truncating — because an indicator that peeks one bar ahead turns a losing
strategy into a spectacular backtest and a disaster in production. Indicator
values are not persisted: they are a pure function of the candles, so storing
them would create a second source of truth to keep in step for no benefit.

`MarketCalendarService` answers "is this symbol tradable right now" and the gate
now asks it whenever an order names a symbol. `TradingGate.evaluate` and
`assertCanTrade` take the evaluation instant as an input rather than reading the
wall clock, so a gate decision is reproducible and auditable.

### Test coverage

487 unit and integration tests plus 38 end-to-end specs, all passing.

| Suite                  | Tests | Covers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared`      | 22    | decimal money, order/signal state machines, permission matrix, environment rules                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `apps/api` unit        | 262   | scrypt hashing, AES-256-GCM envelopes, circuit breaker, redaction and canonical JSON, market simulator determinism, Black-Scholes, demo broker (idempotency, partial fills, cancel races, buying power, fees), Massive.com adapter (null discipline, nanosecond clocks, pagination, splits, rate limits), quality detectors at their exact thresholds, calendar session boundaries and daylight-saving conversion, indicators against hand-computed series plus a look-ahead proof per indicator, the scan evaluator (crossings vs. levels, nulls never matching, boundary inclusivity) |
| `apps/api` integration | 188   | login/MFA/refresh-rotation/reuse-detection/CSRF, client data isolation, RBAC, audit immutability and chain tampering, environment triggers, kill switch, portfolio accounting, market-data ingestion, the quality verdict's effect on the gate, calendar sync, per-symbol tradability, indicator loading and warm-up reporting, the market-data routes (permissions, decimals as strings, warm-up nulls, quality and calendar payloads), watchlist and scan lifecycle, the demo feed's bar grid and session gating                                                                      |
| `apps/web`             | 15    | formatting (never renders unknown as zero), environment banner, kill-switch permission gating                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

### End-to-end coverage

38 Playwright specs drive a real browser against a real API and database. They
exist for what the faster suites structurally cannot check: that the pieces are
wired to each other, and that the honesty rules the backend enforces survive to
the screen — a null indicator rendered as `— needs 50` rather than `0`, an
unevaluable symbol listed rather than dropped, a permission withheld in the UI
as well as the API.

`global-setup` migrates, seeds and backfills through the same npm scripts the
README gives a contributor, so a broken setup path fails the suite rather than
surprising someone on their first day. The backfill window is four days, which
keeps the run near a minute and — not incidentally — leaves daily bars too short
for a 50-period average, which is what makes the scanner's "could not evaluate"
path reachable.

Covered journeys: sign-in and sign-out, a wrong password that does not reveal
whether the account exists, mandatory MFA enrolment for administrators (the code
generated from the enrolment secret, as an authenticator app would), the
dashboard's real figures and per-dependency health, role gating for viewer,
manager and admin, the market page's provenance banner and chart geometry and
crosshair, warm-up rendering, session and tradability verdicts, the scanner's
matches and its unevaluable path, watchlist scoping, saved scans, and the kill
switch including the API refusing a manager's release.

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
9. **Ordinary session hours are a rule; exceptions are data.** `XNYS` regular
   hours (09:30-16:00 America/New_York) live in `MARKET_DEFINITIONS` and are
   converted, once per date and in the market's own time zone, into dated rows.
   Nothing on the read path contains a session boundary — holidays, early
   closes and daylight saving are just rows with different instants. Changing
   an exchange's permanent hours means editing the definition and re-syncing.
10. **Holidays are only as good as the provider's feed.** Massive reports
    upcoming holidays, not historical ones, so a calendar synced for a past
    range has weekends but no holidays. Backfilling needs a second source.
    `sync` propagates a provider failure rather than storing a holiday-free
    calendar, which would report Thanksgiving as a normal trading day.
11. **Halt detection is manual.** The halt mechanism is complete — table,
    service, gate integration, one-open-halt-per-symbol enforced by a partial
    unique index — but nothing populates it automatically. Massive's REST
    surface exposes no halt feed; that needs its WebSocket status channel,
    which is not built.
12. **VWAP's default session anchor is the UTC date.** Right for crypto, wrong
    at the edges for US equities, whose session spans midnight UTC in the
    extended hours. `vwap` takes a session predicate for that reason; pass the
    calendar's view when it matters. Nothing wires them together automatically
    yet.
13. **ADX is not implemented.** Wilder's smoothing helper is shared and ready
    for it, but directional movement is not built. Nothing depends on it.
14. **A scan evaluates only the newest stored bar.** It is not a historical
    screener: "which symbols crossed above their average at any point last
    week" is a different question and would need the backtest engine's
    machinery from Phase 4.
15. **Watchlist symbols have no user-defined order.** They come back
    oldest-added first with ties broken alphabetically; symbols added in one
    bulk create share a timestamp, so insertion order is not recoverable.
    Reordering would need a position column and nothing asks for it yet.
16. **The jump reference is per-process and in-memory.** It is a within-session
    comparison, and reading it back from the database could reintroduce the very
    price about to be rejected. It resets on restart, so the first quote for a
    symbol after a restart is never judged for an abnormal jump.

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

**Phase 2 — Market data. Complete.** One carried item remains, and it belongs
to a later phase:

1. Schedule the calendar sync. Rows are generated on demand today; a deployment
   needs `MarketCalendarService.sync` run ahead of each period. The scheduler
   arrives in Phase 7, so until then it is a manual call.

Phase 2's tests pass, so **Phase 3 — Strategies** may begin: the no-code
strategy builder, the engine over versioned JSON rule trees, versioning with
explicit approval before a live version changes, and the signal engine with
deterministic dedupe keys.
