import { OrderType, TimeInForce } from '@zusu/shared';

/**
 * What Robinhood's trading API actually exposes (§80, Phase 8).
 *
 * This file is the answer to the question that blocked this phase from the
 * start: an adapter cannot be written against a guess about idempotency,
 * fills or multi-leg options, because finding out in production is the
 * failure the whole phase order exists to prevent.
 *
 * The capabilities below were read from Robinhood's own agent-facing tool
 * contract (the connector's published operation schemas) on 2026-09-12. Each
 * is recorded with what it means here, and the one that came back
 * *unconfirmed* is recorded as unconfirmed rather than assumed.
 *
 * ## 1. Client order IDs — CONFIRMED
 *
 * `ref_id` is an idempotency key: a UUID the client generates once per logical
 * order and re-sends on a retry, and the upstream deduplicates on it. That is
 * exactly this platform's model, so `Order.idempotencyKey` maps onto `ref_id`
 * one-to-one and a retried submission cannot open a second position.
 *
 * ## 2. Execution-level fills — PARTIALLY CONFIRMED
 *
 * Order state includes `partially_filled` and `filled`, and an order record
 * carries its fills, so filled quantity and average price are available per
 * order. What the contract does *not* state is whether individual executions —
 * one row per fill, each with its own price, time and id — are exposed.
 *
 * This platform ingests executions idempotently by broker execution id, so the
 * gap matters. Until it is settled against the live API the adapter synthesises
 * one execution per observed fill *delta*, with a deterministic id that says
 * what it is. A synthesised id presented as a real one would make a
 * reconciliation mismatch impossible to interpret.
 *
 * ## 3. Defined-risk multi-leg options — CONFIRMED
 *
 * One to four legs on the same underlying, filled together as one strategy,
 * with a net `direction` (debit or credit), a net limit price and per-leg
 * `ratio_quantity`. Verticals, calendars, iron condors and rolls are named
 * explicitly. Multi-leg requires an `option_level_3` account, is limit-only,
 * and is unavailable on cash and retirement accounts.
 *
 * ## Constraints that shape the adapter
 *
 *  - **Agentic consent is per account.** An order may only be placed on an
 *    account flagged `agentic_allowed`. Not a detail: it is the broker's own
 *    version of this platform's rule that a person authorises.
 *  - **Sessions restrict order types.** Market, stop-market and stop-limit are
 *    regular-hours only; the extended and overnight sessions take limit orders
 *    only. A market order placed after hours queues for the next open rather
 *    than filling, so the adapter refuses it instead of letting a trader
 *    believe they are in the market.
 *  - **Time in force is `gfd` or `gtc`.** This platform's enum also has IOC
 *    and FOK, which have no equivalent and are refused rather than silently
 *    downgraded to a day order.
 *  - **Sells can name tax lots** by `open_lot_id`, which matches this
 *    platform's FIFO lot ledger: the lots it consumes can be the lots the
 *    broker closes, rather than two systems disagreeing about cost basis.
 *  - **Orders carry who placed them** (`placed_agent`: `user`, `agentic`,
 *    `recurring`, …). Reconciliation needs that: an order a person placed in
 *    the Robinhood app is real, is not this platform's, and must be reported
 *    rather than adopted or deleted.
 */

/** Robinhood's order types, as named in its API. */
export const ROBINHOOD_ORDER_TYPES = ['market', 'limit', 'stop_market', 'stop_limit'] as const;
export type RobinhoodOrderType = (typeof ROBINHOOD_ORDER_TYPES)[number];

export const ROBINHOOD_TIME_IN_FORCE = ['gfd', 'gtc'] as const;
export type RobinhoodTimeInForce = (typeof ROBINHOOD_TIME_IN_FORCE)[number];

export const ROBINHOOD_SESSIONS = ['regular_hours', 'extended_hours', 'all_day_hours'] as const;
export type RobinhoodSession = (typeof ROBINHOOD_SESSIONS)[number];

/** Every state Robinhood reports for an equity order. */
export const ROBINHOOD_ORDER_STATES = [
  'new',
  'queued',
  'unconfirmed',
  'confirmed',
  'partially_filled',
  'filled',
  'cancelled',
  'rejected',
  'failed',
  'voided',
] as const;
export type RobinhoodOrderState = (typeof ROBINHOOD_ORDER_STATES)[number];

/** Order types that only execute in the regular session. */
export const REGULAR_HOURS_ONLY: readonly RobinhoodOrderType[] = [
  'market',
  'stop_market',
  'stop_limit',
];

export const ORDER_TYPE_MAP: Readonly<Record<OrderType, RobinhoodOrderType | null>> = Object.freeze(
  {
    [OrderType.MARKET]: 'market',
    [OrderType.LIMIT]: 'limit',
    [OrderType.STOP]: 'stop_market',
    [OrderType.STOP_LIMIT]: 'stop_limit',
  },
);

export const TIME_IN_FORCE_MAP: Readonly<Record<TimeInForce, RobinhoodTimeInForce | null>> =
  Object.freeze({
    [TimeInForce.DAY]: 'gfd',
    [TimeInForce.GTC]: 'gtc',
    // Refused rather than downgraded: an IOC that rests all day is not an IOC,
    // and a trader who asked for one would be holding a position they did not
    // agree to.
    [TimeInForce.IOC]: null,
    [TimeInForce.FOK]: null,
  });
