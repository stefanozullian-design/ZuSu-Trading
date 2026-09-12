# Roadmap

Phases are sequential. A phase does not start until the previous one's tests pass.
Nothing about live trading is built early — the venue integration is Phase 8, and
full automation is never switched on automatically.

Current position: **Phase 9 complete — the build is done.** The automation
ladder, the eight-condition live-readiness gate and the one scheduled job that
may place an order are built. Live trading remains switched off:
`ALLOW_LIVE_TRADING` is false, every seeded configuration sits at
MANUAL_APPROVAL, and nothing automatic runs against a LIVE portfolio however it
was promoted.
Phase 6 remains unverified against the live Anthropic API, which needs a key
this deployment does not have.
See [BUILD_STATUS.md](./BUILD_STATUS.md).

---

## Phase 1 — Foundation ✅

Authentication, users, clients, portfolios, the database, the demo broker, the
dashboard and audit logging. No live trading.

## Phase 2 — Market data ✅

Market-data provider adapter, market-data quality layer, market-calendar engine,
indicator engine, watchlists, scanner, charts.

**External dependency:** resolved — the provider is Massive.com (the former
Polygon.io). A key is still needed to verify the adapter against the live API.

Exit criteria: quotes and candles flow from a real provider; stale, gapped,
duplicated and impossible data is detected and blocks new trades; the calendar
answers "is this symbol tradable right now" without a hard-coded 09:30–16:00;
indicators are computed locally and unit-tested against known series.

## Phase 3 — Strategies ✅

No-code strategy builder, strategy engine over versioned JSON rule trees, strategy
versioning with explicit approval before a live version changes, signal engine with
deterministic dedupe keys.

Exit criteria: a strategy can be built through the UI without code; the same market
event never produces two signals; a live strategy version cannot change silently.

All three hold. A rule is a nested record of conditions evaluated in three-valued
logic — unknown is never permission. Dedupe is a unique index on a key built from
strategy, version, symbol, portfolio and bar open time, so a replay of the same bar
writes nothing. A version is frozen by a database trigger from the moment it is
written: changing a rule adds a version, which starts back at DRAFT and climbs
DRAFT → BACKTEST → PAPER → REVIEW → APPROVED → LIVE one rung at a time, cannot be
approved without a stop loss, records who signed the approval, and cannot go live
beside another live version. Approved is not running: the last step is separate.

## Phase 4 — Backtesting ✅

Historical data pipeline, event-driven backtest engine, performance metrics,
walk-forward analysis, Monte Carlo, strategy comparison, parameter optimisation
with overfitting warnings.

Exit criteria: a look-ahead-bias test suite passes (only information available at
time T may inform a decision at T); fees, spread and slippage are modelled and
gross returns are never reported as realised performance; optimised parameters are
never deployed automatically.

All three hold. A decision on a closed bar fills at the next bar's open, the
look-ahead suite includes a prefix-invariance proof, and walk-forward folds
recompute their indicators rather than borrowing a series computed over the whole
history. Commission, half the spread and a slippage fraction are charged on every
fill; the gross figure is reported beside the net one so the cost is visible.
Optimisation returns a ranking and the reasons to doubt it, stores nothing, and
cannot write a version.

## Phase 5 — Paper trading ✅

Paper broker with modelled order latency, partial fills, bid/ask spread, slippage
and realistic stop behaviour. Portfolio accounting (time- and money-weighted
returns, deposits and withdrawals, tax lots), the trade journal.

Exit criteria: paper fills are not "every market order at the candle close";
portfolio return is correct in the presence of deposits and withdrawals.

Both hold. A paper order fills only from a bar that opened after it was
submitted, takes at most a fraction of that bar's volume — so a large order
fills across several bars — pays the spread plus slippage that grows with its
participation, and fills a gapped stop at the open rather than at the stop. A
deposit is recorded as its own row and removed from both return measures: the
time-weighted figure chains period returns and the money-weighted one is an
internal rate of return over the dated flows, and the API reports both rather
than choosing the flattering one.

The order pipeline that arrived with it is where the product's premise lives: a
signal becomes an order only through `POST /signals/:id/approve`, which requires
a person holding `signal:approve` and trading rights on the portfolio. Nothing
in the codebase calls it automatically, and there is no setting that would.

## Phase 6 — Claude ✅ (unverified against the live API)

AI analysis engine with structured input and schema-validated structured output,
the two-stage cheap-screen-then-analyse architecture, cost and rate controls, AI
logging and reasoning display, market-regime detection, notifications.

Exit criteria: an invalid or unexpected AI response results in **no trade**; per-
minute, per-day and budget caps are enforced; AI confidence alone never authorises
anything.

All three hold, and the third is structural: the output schema has no field an
order could be built from, so a model cannot express an instruction to trade
even if it tries. An unparseable reply is stored as a failure with its raw text
and contributes no advice. A call that would cross the daily budget or the
hourly ceiling is refused before the money is spent, and the refusal is a row.

**External dependency: unresolved.** This deployment has no `ANTHROPIC_API_KEY`,
so nothing here has spoken to the live API. The adapter, the schemas, the
governor and the two-stage flow are tested against a fake transport — the same
approach the market-data adapter took — and the first real call may still find
something unhandled. With no key the platform says so on screen and records the
refusal; it never substitutes a plausible-looking opinion.

## Phase 7 — Risk engine ✅

Position sizing (fixed, percentage, risk-based, ATR-based, fractional Kelly with
conservative defaults), portfolio limits, sector and correlation exposure,
drawdown, automatic and manual kill switches, circuit breakers, the scan scheduler.

Exit criteria: every hard limit rejects an order with a human-readable reason;
concentrated exposure across correlated symbols is recognised, not just duplicate
tickers.

Both hold. Every check reports its limit name, the limit value and the actual
value, so a refusal reads "sector exposure exceeded: 42.76 against a limit of
30.00 percent of equity in Technology" rather than "risk limit exceeded".
Correlation is measured on stored returns rather than inferred from sector, and
a symbol with too little history to measure blocks rather than passes.

Sizing is fixed-fractional: the quantity follows from the distance to the stop,
so a wider stop buys fewer shares and the loss if the stop is hit is the same
fraction of equity either way. Without a stop it refuses rather than falling
back to a notional cap, which would change the method without saying so.
Fractional Kelly is deliberately absent — it needs an edge estimate the
platform does not have, and a sizing method resting on a fabricated win rate is
worse than a simple one.

The scheduler arrived with it, and clears the items four earlier phases were
carrying: calendar sync, health persistence, order polling, daily snapshots,
live-strategy evaluation and the drawdown breaker. Every job may stop trading
and none may start any — the closest it comes is producing recommendations that
then wait for a person.

## Phase 8 — Broker ✅

Live broker adapter, authentication, order management with idempotency, executions
and partial fills, positions, reconciliation, error handling.

**External dependency: resolved, from the venue's own published contract.** The
three capability questions were answered by reading Robinhood's published tool
schemas on 2026-09-12 — no calls were made, no account was read, no order was
placed. The findings are recorded verbatim in
`apps/api/src/modules/broker/robinhood/contract.ts`, each marked with how
strongly the evidence supports it:

| Question                         | Finding                                                                                                                                                                                      |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Client order IDs for idempotency | **Confirmed** — `ref_id` on order placement.                                                                                                                                                 |
| Execution-level fills            | **Partially confirmed** — fill quantity and average price are exposed; per-execution rows are not clearly documented, so the adapter synthesises a stable execution id and says that it did. |
| Defined-risk multi-leg options   | **Confirmed** — 1–4 legs, limit orders only, `option_level_3` required.                                                                                                                      |

Three constraints the schemas made explicit, which the adapter now enforces
rather than discovering at rejection time: per-account `agentic_allowed`
consent, `gfd`/`gtc` time-in-force only (IOC and FOK have no equivalent and are
refused rather than substituted), and regular trading hours only for market
orders.

Exit criteria: a crash immediately after submission never produces a duplicate
order; internal records and broker records are reconciled, and a mismatch halts
trading for the affected portfolio rather than being silently overwritten.

## Phase 9 — Live trading ✅

Manual approval only, then paper → manual live → limited auto → full auto, each
step promoted explicitly by a person.

The eight conditions are a service, `LiveReadinessService`, and each is checked
independently with its own evidence: a completed backtest of at least 20 trades
(the stored result, not the stage label), a profitable paper test of at least 10
round trips over at least 5 days, active risk limits, recorded position sizing,
a stop in the definition, an armed kill switch, a broker that answers a health
check, and a reconciliation that matched within the last 24 hours.

A check that cannot be run reports `UNVERIFIABLE` and blocks. "We have never
reconciled" and "we reconciled and it matched" are different answers, and the
one place that distinction gets quietly lost is a readiness gate.

**Full automation is never activated automatically**, enforced four ways:
one rung per promotion (so FULL_AUTO is at least two deliberate decisions after
MANUAL_APPROVAL), the `strategy:promote` permission (administrator-only), a
typed confirmation naming the rung, and an all-pass readiness report. Lowering
needs none of them and is never refused — a brake a state machine can decline
to apply is not a brake.

---

## Cross-cutting work, scheduled with the phase that needs it

| Work                                               | Phase                                         |
| -------------------------------------------------- | --------------------------------------------- |
| Options engine and options position safety         | 8 (needs broker confirmation)                 |
| Strategy health monitoring and deviation alerts    | 5–7                                           |
| Live vs paper vs backtest comparison               | 5                                             |
| Reporting, fee engine, tax-lot export              | after 5                                       |
| Compliance disclosures, consent records, retention | before any live use                           |
| Row-level security in PostgreSQL                   | hardening, after the connection model settles |
| Playwright end-to-end suite                        | 2                                             |
