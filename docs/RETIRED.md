# What has been retired, and how to get it back

ZuSu began as a platform that would route its own orders: strategies produced
signals, a person approved them, an execution venue filled them, and backtests
argued about whether the rules were any good. That is not the tool in use. These
portfolios are held at a real brokerage — the acting happens there, and what is
wanted here is a recommender and an honest book of record.

So a large amount of working, tested code now has no way to be reached. **None
of it has been thrown away.** This file is the catalogue: what each piece did,
where it still lives, what would break if it came back, and what it would cost.

Nothing here is a judgement that the code was wrong. Most of it is good, and
some of it will be wanted again.

---

## Deleted from the working tree (recoverable from git)

These five files were removed in commit `345a003`. They are intact in git and
restore with a single command each; the commit before it, `6a1f366`, is the
last one in which they were live.

| File                                                  | What it was                                                                                                                                 | Lines |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| `apps/web/src/pages/TradingPage.tsx`                  | The approval queue: recommendations waiting for a person, with the reasoning beside each, plus the order blotter and the AI-analysis panel. | ~880  |
| `apps/web/src/pages/StrategiesPage.tsx`               | Strategy authoring, versions, the promotion ladder from suggest-only to automated.                                                          | ~700  |
| `apps/web/src/pages/AutomationPage.tsx`               | Per-strategy automation level and its guard rails.                                                                                          | ~400  |
| `apps/web/src/pages/BacktestPage.tsx`                 | Running a version over history, walk-forward and Monte Carlo.                                                                               | ~550  |
| `apps/web/src/components/strategy/RuleTreeEditor.tsx` | The nested AND/OR condition builder those strategies were written in.                                                                       | ~280  |

Five e2e specs went with them: `trading`, `strategies`, `automation`,
`backtests`, `analysis`.

To restore one:

```
git checkout 6a1f366 -- apps/web/src/pages/TradingPage.tsx
```

Restoring a page is not enough to reach it — the route and the nav item were
removed from `apps/web/src/App.tsx` in the same commit, and `TradingPage`
imported `ImportPosition`, which now lives at
`apps/web/src/components/ImportPosition.tsx` and needs importing from there.

---

## Present but unreachable (still compiled, still tested)

The API modules behind those pages were **not** touched. They build, their
tests run, and every endpoint still answers — nothing in the UI calls them.

| Module               | Lines | What it does                                                                              | Still used by                                                                                                      |
| -------------------- | ----- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `modules/broker`     | 4,742 | Venue adapters, the paper execution venue, reconciliation against a broker's own records. | Nothing in the UI. The paper venue is what used to fill orders.                                                    |
| `modules/backtest`   | 3,218 | Backtest engine, walk-forward, Monte Carlo, optimisation.                                 | Nothing.                                                                                                           |
| `modules/strategies` | 1,873 | Strategy definitions, versions, rule evaluation, signal generation, the promotion ladder. | Nothing in the UI.                                                                                                 |
| `modules/orders`     | 1,728 | Order lifecycle, executions — **and `position-book.ts`, the FIFO tax-lot engine.**        | **`position-book.ts` is live and load-bearing.** Every recorded buy and sell goes through it. The rest is dormant. |
| `modules/ai`         | 1,787 | The Anthropic adapter, screening and analysis, cost accounting.                           | Nothing. Never had a key configured.                                                                               |
| `modules/automation` | 1,090 | Automation levels and the rules about what may act unattended.                            | Nothing.                                                                                                           |

**The one trap in this table is `modules/orders`.** It reads as dead weight and
is not: `position-book.ts` is the tax-lot arithmetic that makes a recorded sale
produce a correct realised gain. Deleting the orders module would take it with
it. If that module is ever cleaned up, `position-book.ts` moves out first.

`modules/market-data` (7,564 lines) is the largest module in the repository and
is entirely live — instruments, candles, indicators, watchlists, scans, the
provider sync. The scanner is built on it, and so is everything planned next.

---

## Database objects with no UI

Tables and enums for the retired machinery are still in the schema, still
migrated, and hold whatever the demo seed and the old e2e runs put in them:
`strategies`, `strategy_versions`, `signals`, `signal_events`, `orders`,
`order_events`, `executions`, `broker_accounts`, `backtests`, `ai_analyses`,
`automation_configs`.

They are cheap to keep and expensive to recreate, because the audit log
references rows in several of them and the audit log cannot be rewritten.
Leaving them is the right default.

`position_lots.execution_id` is nullable precisely because of this split: a lot
opened by a routed fill points at an execution, and a lot opened by a trade
recorded by hand points at nothing. Both are legitimate.

---

## What was kept on purpose

- **The Scanner.** It is the surviving notion of a "method" — a saved set of
  conditions over indicators. The comparison view being built next is built on
  saved scans, not on strategies.
- **`components/backtest/EquityCurve.tsx`.** It is a chart, not backtest
  machinery, and the Performance page draws with it.
- **The kill switch and the risk engine.** They still do real work: the risk
  engine sizes and checks, and the kill switch remains the one control that
  stops everything.
- **The permission matrix, in full.** `signal:approve` and `order:write` no
  longer gate any screen. They are left in place because taking a permission
  out of the matrix and putting it back is how a role quietly gains an ability
  nobody decided to give it.

---

## How to decide whether to bring something back

The question that retired all of it: **does this help decide what to buy, or
keep an honest record of what was done?** Strategies, signals, orders,
executions and automation answered a different question — how to act without a
person. Backtests answered whether an automated rule was any good.

If the answer changes — if a portfolio is ever routed from here — the machinery
to do it is written, tested and one commit away. That is the reason none of it
was deleted.
