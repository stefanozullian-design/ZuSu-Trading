# Roadmap

Phases are sequential. A phase does not start until the previous one's tests pass.
Nothing about live trading is built early — the venue integration is Phase 8, and
full automation is never switched on automatically.

Current position: **Phase 5 complete.** Phase 6 (Claude analysis) is next.
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

## Phase 6 — Claude

AI analysis engine with structured input and schema-validated structured output,
the two-stage cheap-screen-then-analyse architecture, cost and rate controls, AI
logging and reasoning display, market-regime detection, notifications.

Exit criteria: an invalid or unexpected AI response results in **no trade**; per-
minute, per-day and budget caps are enforced; AI confidence alone never authorises
anything.

## Phase 7 — Risk engine

Position sizing (fixed, percentage, risk-based, ATR-based, fractional Kelly with
conservative defaults), portfolio limits, sector and correlation exposure,
drawdown, automatic and manual kill switches, circuit breakers, the scan scheduler.

Exit criteria: every hard limit rejects an order with a human-readable reason;
concentrated exposure across correlated symbols is recognised, not just duplicate
tickers.

## Phase 8 — Broker

Live broker adapter, authentication, order management with idempotency, executions
and partial fills, positions, reconciliation, error handling.

**External dependency:** the broker's API capabilities must be confirmed first —
client order IDs (for idempotency), execution-level fills (for partial fills and
reconciliation), and defined-risk multi-leg option orders. Nothing should be
assumed about the venue, and the trading engine must not acquire any
broker-specific assumptions.

Exit criteria: a crash immediately after submission never produces a duplicate
order; internal records and broker records are reconciled, and a mismatch halts
trading for the affected portfolio rather than being silently overwritten.

## Phase 9 — Live trading

Manual approval only, then paper → manual live → limited auto → full auto, each
step promoted explicitly by a person.

A strategy may go live only when: a backtest is complete, a paper test meets its
configured criteria, risk limits and position sizing are configured, a stop loss is
set, the kill switch is available, the broker connection is verified, reconciliation
is healthy, and a user confirms.

**Full automation is never activated automatically.**

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
