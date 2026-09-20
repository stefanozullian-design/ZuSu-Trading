-- Recording a trade that happened somewhere else.
--
-- Most of these portfolios are held at a real brokerage. This platform's job is
-- to say what to do and then to keep an honest book of what was done — so a
-- buy, a sell, a dividend, a deposit and a withdrawal all have to be typeable
-- after the fact. Buys and sells reuse the tax-lot engine unchanged; the only
-- thing the database was missing was a way to say that cash arrived as income
-- rather than as somebody's wire.
--
-- The distinction matters and is not cosmetic. A deposit raises equity without
-- anyone having earned it, so a return calculation subtracts it. A dividend
-- raises equity *because* of what is held, so subtracting it would erase part
-- of the return it represents. They cannot share a type.

ALTER TYPE "CashFlowType" ADD VALUE 'DIVIDEND';

-- The ledger of what was typed in.
--
-- Positions, lots and cash flows record the *effect* of an entry; none of them
-- records the entry. A buy becomes a lot, a sale becomes a consumed lot and a
-- changed quantity, and neither can answer "what did I enter on the 14th, and
-- at what price" once a later trade has moved through them. A book of record
-- needs the entries themselves, so they get a table.
--
-- It is append-only in practice rather than by trigger: a correction is a new
-- entry in the other direction, the same way the rest of this system treats a
-- reversal, because an edited history is one nobody can reconcile against a
-- brokerage statement.
CREATE TYPE "RecordedTradeType" AS ENUM ('BUY', 'SELL', 'DIVIDEND', 'DEPOSIT', 'WITHDRAWAL');

CREATE TABLE "recorded_trades" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "portfolio_id" UUID NOT NULL,
    "type" "RecordedTradeType" NOT NULL,
    "symbol" TEXT,
    "quantity" DECIMAL(24,8),
    "price" DECIMAL(24,8),
    "fees" DECIMAL(24,8) NOT NULL DEFAULT 0,
    -- Signed, so a sum is the net movement and no reader has to remember which
    -- types take money out.
    "cash_delta" DECIMAL(24,8) NOT NULL,
    "realized_pnl" DECIMAL(24,8),
    "position_id" UUID,
    "cash_flow_id" UUID,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "note" TEXT,
    "recorded_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recorded_trades_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "recorded_trades"
  ADD CONSTRAINT "recorded_trades_portfolio_id_fkey"
  FOREIGN KEY ("portfolio_id") REFERENCES "portfolios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The position and the cash flow may be deleted out from under an entry; the
-- entry stays, because it still records what was done.
ALTER TABLE "recorded_trades"
  ADD CONSTRAINT "recorded_trades_position_id_fkey"
  FOREIGN KEY ("position_id") REFERENCES "positions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "recorded_trades"
  ADD CONSTRAINT "recorded_trades_cash_flow_id_fkey"
  FOREIGN KEY ("cash_flow_id") REFERENCES "cash_flows"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "recorded_trades"
  ADD CONSTRAINT "recorded_trades_recorded_by_user_id_fkey"
  FOREIGN KEY ("recorded_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "recorded_trades_portfolio_id_occurred_at_idx"
  ON "recorded_trades"("portfolio_id", "occurred_at" DESC);

CREATE INDEX "recorded_trades_portfolio_id_symbol_idx"
  ON "recorded_trades"("portfolio_id", "symbol");

-- A buy or a sell is meaningless without a symbol, a share count and a price;
-- a deposit, withdrawal or dividend has no share count or price to carry. The
-- database refuses the contradictions rather than trusting every writer.
ALTER TABLE "recorded_trades"
  ADD CONSTRAINT "recorded_trades_shares_have_a_symbol_and_a_price"
  CHECK (
    ("type" IN ('BUY', 'SELL')) =
    ("symbol" IS NOT NULL AND "quantity" IS NOT NULL AND "price" IS NOT NULL)
  );

ALTER TABLE "recorded_trades"
  ADD CONSTRAINT "recorded_trades_quantities_are_positive"
  CHECK ("quantity" IS NULL OR "quantity" > 0);

ALTER TABLE "recorded_trades"
  ADD CONSTRAINT "recorded_trades_prices_are_positive"
  CHECK ("price" IS NULL OR "price" > 0);
