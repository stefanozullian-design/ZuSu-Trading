# Build status

**Current phase: 5 — Paper trading. Complete.** Phase 6 (Claude analysis) is next.
**Live trading: not possible.** Orders exist now, but only in the DEMO and PAPER
environments — the live adapter arrives in Phase 8 and `ALLOW_LIVE_TRADING`
defaults to false. No order can be created without a person: the only path from
a recommendation to a broker requires `signal:approve` and is never called
automatically.

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
| 3. Data-quality layer           | Done — eight detectors, the only write path into market-data tables.                                                                                                      |
| 4. Market-calendar engine       | Done — dated rows of absolute UTC instants. See the `getCalendar` limitation below.                                                                                       |
| 5. Indicator engine             | Done — eleven indicators, each with a look-ahead proof.                                                                                                                   |
| 6. Watchlists, scanner, charts  | Done — the Market and Scanner pages.                                                                                                                                      |
| 7. Playwright E2E suite         | Done.                                                                                                                                                                     |

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

### Phase 3 — Strategies

| Step                         | State                                                                                                                                                          |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Rule tree                 | Done — nested all/any/not over the scanner's condition language, evaluated in three-valued logic.                                                              |
| 2. Versioning and the ladder | Done — frozen on write by a database trigger; DRAFT → BACKTEST → PAPER → REVIEW → APPROVED → LIVE, one rung at a time, signed at APPROVED, one live at a time. |
| 3. Signal engine             | Done — deterministic dedupe key enforced by a unique index, full rule trace stored with each signal.                                                           |
| 4. Routes                    | Done — `/api/strategies`, versions, promotion, evaluation, signals. None of them can place an order.                                                           |
| 5. The builder UI            | Done — `/strategies`. A rule is assembled from selects; nothing typed there is ever executed.                                                                  |

**The rule language is shared with the scanner.** `condition.ts` holds the
fields, the operators and the evaluator; the scanner uses a flat list of them
and the strategy engine nests them. Extracting it was the point: two expression
editors would have been two dialects that eventually disagree about what
"close crosses above sma50" means.

**A rule's verdict is three-valued.** True, false, or unknown — and unknown is
never permission. `all` is false if any child is false, unknown if any child is
unknown, true only when every child is true; `any` mirrors it; `not` of unknown
stays unknown. Nothing short-circuits, so the trace stored with a signal can
answer "what else was true at the time" rather than only "it fired".

**Depth stops at six, a group holds ten children, a tree holds sixty nodes.**
The schema is an explicit depth ladder rather than a lazy recursive one,
because a `z.lazy` schema has no depth limit at all — a hostile payload could
nest until the evaluator ran out of stack. A rule nobody can read is also a
rule nobody reviews honestly.

**Dedupe is a database guarantee, not a check.** The key is
`STRATEGY_vN:SYMBOL:PORTFOLIO:BAR_OPEN_TIME` minute-truncated, and a unique
index on it is what makes a replay of the same bar write nothing. Two
concurrent evaluations both reach the insert and exactly one wins; the loser is
reported as a duplicate rather than an error.

**A signal stops at CREATED.** The most any route here does is record a
recommendation. There is no code path from this module to an order — the risk
engine and the order manager that would provide one do not exist yet, so the
boundary is structural rather than a promise.

**Evaluation refuses a stale bar.** A live run against Friday's last candle on
a Sunday would be a recommendation about a market that has not been open since.
Bars more than five intervals old are reported as unjudgeable, with their age,
rather than judged as current.

**An unreadable version degrades rather than breaks.** Versions are immutable
and kept forever, so a definition written in an older rule language will exist
one day. It is reported with a null definition and shown as unreadable — never
guessed at, never promoted, never evaluated, and never allowed to take the rest
of the listing down with it. The Phase 1 seed's placeholder definitions were
exactly this case, invented before the rule language existed; they are now
written in the real one, because demo data the product cannot read is fiction.

### Phase 4 — Backtesting

| Step                     | State                                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------------ |
| 1. Historical pipeline   | Done — ranged candle loads, no longer silently trimmed to the newest 500 bars.                   |
| 2. Event-driven engine   | Done — one time-ordered walk across every symbol, sharing capital and the position limit.        |
| 3. Performance metrics   | Done — net of every modelled cost, with the statistics it refuses to compute named as refusals.  |
| 4. Walk-forward          | Done — consecutive in/out-of-sample folds, indicators recomputed per fold.                       |
| 5. Monte Carlo           | Done — seeded resampling of the realised trades, reported as sequence risk rather than forecast. |
| 6. Parameter search      | Done — a ranking plus the reasons to doubt it. Stores nothing and cannot write a version.        |
| 7. Look-ahead-bias suite | Done — including a prefix-invariance proof.                                                      |
| 8. The Backtests page    | Done — `/backtests`, where every result arrives with its assumptions.                            |

**The engine's five rules, each the opposite of a standard way a backtest
lies:**

1. **A decision on bar N fills at the open of bar N+1.** The rule is evaluated
   on a closed bar, so its close is known; filling there would be trading on
   information that arrived at the moment of the decision. A signal on the last
   bar therefore produces no trade at all rather than a fill at a price nobody
   could have had.
2. **Costs are never optional.** A half-spread and a slippage fraction move
   every fill against the position and commission is charged on both sides.
   Gross and net are reported side by side.
3. **A gap fills at the open, not at the stop.** Pretending the stop held
   through a gap is the single most common way a backtest overstates a
   strategy.
4. **An ambiguous bar resolves against the position.** A bar is a summary, not
   a path: when its range contains both the stop and the target, nothing in the
   data says which came first. The stop is taken and those bars are counted, so
   a result resting on many of them can be distrusted on the evidence.
5. **Unknown is not a signal.** A bar whose indicators have not warmed up
   produces no trade and is counted separately from the rule saying no.

**The metrics refuse as much as they report.** Sharpe and Sortino are withheld
below thirty return observations; CAGR is withheld for a window under a month;
the profit factor is null rather than infinite when nothing lost; a constant
return stream gets no ratio at all, because dividing by arithmetic residue
produced a Sharpe in the quadrillions. Where a ratio is defined but misleading
— capital at risk in under a quarter of the bars inflates an annualised figure
well past anything a person would experience — it is reported with that stated
next to it rather than quietly.

**Optimisation always argues against itself.** Every search reports that the
best of many candidates is partly a measure of how many were tried, plus
warnings for a thin trade count, a sharp peak rather than a plateau, a runner-up
less than half as good, and a mostly-unprofitable family. It writes nothing: a
search of the past choosing the rules that trade real money is the decision this
platform reserves for a person.

**One bug this phase surfaced, worth recording.** The candle loader defaulted to
the newest 500 bars, and a ranged load inherited that default — so the first
backtest over a month of history quietly read five days and labelled the result
as a month. A ranged load is now bounded by its range, a load that would exceed
100,000 rows fails rather than returning a short window, and every stored result
carries the span its bars actually covered.

### Phase 5 — Paper trading

| Step                      | State                                                                                                                          |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 1. Paper broker           | Done — priced from stored market bars, with latency, finite liquidity, spread, participation-scaled slippage and gapped stops. |
| 2. Order manager          | Done — idempotent orders, once-only execution ingestion, the shared state machine, a rejected order kept as a row.             |
| 3. Positions and tax lots | Done — one lot per opening fill, FIFO consumption, a closed position kept as history.                                          |
| 4. Portfolio accounting   | Done — time- and money-weighted returns with external flows removed, daily snapshots, drawdown.                                |
| 5. Trade journal          | Done — the thesis captured at entry by the system, notes appended and never overwritten.                                       |
| 6. The Trading page       | Done — `/trading`, the approval queue, positions with their lots, orders with their slippage.                                  |
| 7. The Performance page   | Done — `/performance`, both return measures side by side, cash flows, the journal.                                             |

**The premise, in code.** A signal becomes an order through exactly one
function, `OrderService.approveSignal`, reachable through exactly one route,
and both require a person holding `signal:approve` plus trading rights on the
portfolio. There is no scheduler, sweeper or setting that calls it. The UI has
no "approve all" and no automation toggle — an end-to-end spec asserts the
absence of those controls, because a promise about automation is worth less
than a test that fails when one appears.

**What survives the act.** Every order carries a unique idempotency key,
derived from the signal for an approval, so two people approving at once
produce one order rather than two positions. Every execution is ingested once
(`brokerExecId` is unique), so polling an order repeatedly cannot double a
position. A transport failure leaves an order `UNKNOWN`, never `CANCELLED`:
"we do not know" is a state, and pretending otherwise is how a position nobody
knows about gets opened. A refused order is stored with its reason.

**Tax lots, not an average.** Each opening fill creates a lot with its own cost
basis and opening date; a sale consumes lots oldest-first and attributes the
gain to each. An average price cannot answer "what did we pay for these
particular shares, and when", which is the question the holding period turns
on. A reversal is two events — the old position closes and a new one opens at
the fill that opened it — never one position that changed sign.

**A deposit is not a profit.** The one performance lie this module exists to
prevent. Both return measures remove external flows, the time-weighted figure
treats a flow as capital the trading had to work with from the start of its
period, and the money-weighted figure is withheld for windows under a week
where annualising an IRR produces a number in the thousands of percent. The
conventions travel with the report rather than living in a document.

**Pre-trade checks say what they did not check.** Position size, open position
count, trades today and cash on hand are verified; the daily loss limit,
exposure percentages, correlation and drawdown breakers are named in
`LIMITS_NOT_YET_ENFORCED` and belong to the risk engine in Phase 7. A caller
reading a passed check is told exactly what it covered — a partial check
reported as a full one would be worse than no check at all.

**One honesty fix found while building the page.** The positions view served
`unrealizedPnl` straight from the column, which is only written at fill time,
so a seeded position rendered "0.00" — indistinguishable from flat. Marks are
now computed on read from the newest stored bar, and a symbol with no stored
price returns null so the UI can say "not priced".

### Test coverage

718 unit and integration tests plus 62 end-to-end specs, all passing.

| Suite                  | Tests | Covers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared`      | 22    | decimal money, order/signal state machines, permission matrix, environment rules                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `apps/api` unit        | 356   | scrypt hashing, AES-256-GCM envelopes, circuit breaker, redaction and canonical JSON, market simulator determinism, Black-Scholes, demo broker (idempotency, partial fills, cancel races, buying power, fees), Massive.com adapter (null discipline, nanosecond clocks, pagination, splits, rate limits), quality detectors at their exact thresholds, calendar session boundaries and daylight-saving conversion, indicators against hand-computed series plus a look-ahead proof per indicator, the scan evaluator (crossings vs. levels, nulls never matching, boundary inclusivity), the rule tree's Kleene logic and depth limits               |
| `apps/api` integration | 325   | login/MFA/refresh-rotation/reuse-detection/CSRF, client data isolation, RBAC, audit immutability and chain tampering, environment triggers, kill switch, portfolio accounting, market-data ingestion, the quality verdict's effect on the gate, calendar sync, per-symbol tradability, indicator loading and warm-up reporting, the market-data routes (permissions, decimals as strings, warm-up nulls, quality and calendar payloads), watchlist and scan lifecycle, the demo feed's bar grid and session gating, the strategy ladder and its gates, signal dedupe under concurrency, stale-bar refusal, and the strategy routes' permission split |
| `apps/web`             | 15    | formatting (never renders unknown as zero), environment banner, kill-switch permission gating                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

### End-to-end coverage

62 Playwright specs drive a real browser against a real API and database. They
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
matches and its unevaluable path, watchlist scoping, saved scans, building a
nested strategy rule and reading it back in words, a manager who may author but
not promote, an admin walking a version to live one rung at a time, a dry run
accounting for every symbol it looked at, a backtest that arrives with its
modelling assumptions and its gross figure beside its net one, an approval queue
with no "approve all" control anywhere on it, a rejection that will not submit
without a reason, both return measures on screen together, and the kill switch
including the API refusing a manager's release.

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
| No snapshot scheduler                        | `PerformanceService.writeSnapshot` exists and is called on demand; the daily timer belongs with the scheduler (Phase 7).                                                                                                                                                                               |
| Health checks are not persisted on a timer   | `HealthService.persist` exists but nothing calls it on a schedule; that arrives with the scheduler (Phase 7).                                                                                                                                                                                          |
| Container images build only in CI            | `docker build` cannot run in the development sandbox — its network policy blocks Docker Hub's blob CDN — so the two Dockerfiles are verified by CI's `docker` job rather than locally. Both images built successfully on the first run. Changes to either Dockerfile cannot be checked before pushing. |
| Rate limiting is per-process                 | Fine for a single instance; needs the Redis store before running more than one API replica.                                                                                                                                                                                                            |
| `apps/web` has no route-level code splitting | Irrelevant at this size; revisit when charting and backtesting views land.                                                                                                                                                                                                                             |

## Next steps

**Phase 5 — Paper trading. Complete.** Five carried items remain, all belonging
to later phases:

1. Schedule the calendar sync. Rows are generated on demand today; a deployment
   needs `MarketCalendarService.sync` run ahead of each period. The scheduler
   arrives in Phase 7, so until then it is a manual call.
2. Schedule strategy evaluation. `SignalService.evaluateAllLive` exists and is
   called by nothing on a timer; a live strategy is evaluated when someone asks
   for it. The scheduler arrives in Phase 7.
3. Schedule the daily snapshot. `PerformanceService.writeSnapshot` is called on
   demand and from the Performance page; the daily timer arrives with the
   scheduler. A report says how many snapshots it had, so a gap is visible
   rather than smoothed over.
4. Poll open orders. An order's fills are applied when somebody syncs it or
   reloads the page; a background poller belongs with the scheduler. Nothing is
   lost in the meantime — ingestion is idempotent, so a late sync applies
   exactly what a timely one would have.
5. Run backtests in the background. A run over a few thousand bars takes
   milliseconds, so it happens inline; a window of years will need a queue.

Phase 5's tests pass, so **Phase 6 — Claude** may begin: the two-stage
cheap-screen-then-analyse architecture, schema-validated structured output,
cost and rate controls, the reasoning display, regime detection and
notifications. **It needs an `ANTHROPIC_API_KEY`**, which this deployment does
not have — the adapter and its tests can be built against a fake transport, as
the market-data adapter was, but nothing can be verified against the real API
until a key exists.
