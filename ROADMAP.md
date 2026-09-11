# Roadmap

Phases are sequential. A phase does not start until the previous one's tests pass.
Nothing about live trading is built early — the venue integration is Phase 8, and
full automation is never switched on automatically.

Current position: **Phase 1 complete.** See [BUILD_STATUS.md](./BUILD_STATUS.md).

---

## Phase 1 — Foundation ✅

Authentication, users, clients, portfolios, the database, the demo broker, the
dashboard and audit logging. No live trading.

## Phase 2 — Market data

Market-data provider adapter, market-data quality layer, market-calendar engine,
indicator engine, watchlists, scanner, charts.

**Provider: Alpaca** (chosen 2026-09-11). It carries market data and a broker API
together, and its paper environment maps onto the PAPER environment already in the
schema — so Phase 5's paper broker becomes a real venue rather than one we
simulate. **Needs from the operator:** an Alpaca key id and secret in the
environment. The free tier is IEX-only, which is thin but sufficient to build and
validate the whole layer against; upgrading the feed later does not change the
adapter.

Exit criteria: quotes and candles flow from a real provider; stale, gapped,
duplicated and impossible data is detected and blocks new trades; the calendar
answers "is this symbol tradable right now" without a hard-coded 09:30–16:00;
indicators are computed locally and unit-tested against known series.

## Phase 3 — Strategies

No-code strategy builder, strategy engine over versioned JSON rule trees, strategy
versioning with explicit approval before a live version changes, signal engine with
deterministic dedupe keys.

Exit criteria: a strategy can be built through the UI without code; the same market
event never produces two signals; a live strategy version cannot change silently.

## Phase 4 — Backtesting

Historical data pipeline, event-driven backtest engine, performance metrics,
walk-forward analysis, Monte Carlo, strategy comparison, parameter optimisation
with overfitting warnings.

Exit criteria: a look-ahead-bias test suite passes (only information available at
time T may inform a decision at T); fees, spread and slippage are modelled and
gross returns are never reported as realised performance; optimised parameters are
never deployed automatically.

## Phase 5 — Paper trading

Paper broker with modelled order latency, partial fills, bid/ask spread, slippage
and realistic stop behaviour. Portfolio accounting (time- and money-weighted
returns, deposits and withdrawals, tax lots), the trade journal.

Exit criteria: paper fills are not "every market order at the candle close";
portfolio return is correct in the presence of deposits and withdrawals.

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

**Capabilities confirmed** for Robinhood on 2026-09-11 — see the survey in
BUILD_STATUS.md. `ref_id` gives us idempotency, `executions[]` gives us
execution-level fills, and specified-lot selling gives us tax lots. Two
constraints carry into the design: only one account is reachable for trading, and
orders placed by hand in the broker's own app arrive with a null `ref_id`, so
reconciliation must match on the broker's order id and must expect to find orders
this system did not place.

Multi-leg defined-risk options are supported by the API but need an
`option_level_3` account, which is not enabled today.

The trading engine must still acquire no broker-specific assumptions: everything
above belongs behind `BrokerAdapter`.

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
