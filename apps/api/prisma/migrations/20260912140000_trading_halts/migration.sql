-- Trading halts (§7).
--
-- A halt is a window in time on one symbol, which is why it is not a boolean on
-- `instruments`: `is_tradable` says whether a symbol is ever tradable (listed,
-- supported), a halt says it is not tradable *right now* and records why.
-- Keeping them apart means releasing a halt cannot accidentally re-enable a
-- delisted symbol.

CREATE TABLE "trading_halts" (
  "id"            UUID NOT NULL,
  "instrument_id" UUID NOT NULL,
  "symbol"        TEXT NOT NULL,
  "reason"        TEXT NOT NULL,
  "detail"        TEXT,
  "source"        TEXT NOT NULL,
  "halted_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "released_at"   TIMESTAMP(3),

  CONSTRAINT "trading_halts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "trading_halts_symbol_released_at_idx"
  ON "trading_halts" ("symbol", "released_at");

CREATE INDEX "trading_halts_halted_at_idx" ON "trading_halts" ("halted_at");

ALTER TABLE "trading_halts"
  ADD CONSTRAINT "trading_halts_instrument_id_fkey"
  FOREIGN KEY ("instrument_id") REFERENCES "instruments"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- A halt cannot be released before it began.
ALTER TABLE "trading_halts"
  ADD CONSTRAINT "trading_halts_released_after_halted"
  CHECK ("released_at" IS NULL OR "released_at" >= "halted_at");

-- At most one open halt per symbol. Without this, two detectors racing would
-- leave two open rows and releasing one would read as "no longer halted".
CREATE UNIQUE INDEX "trading_halts_one_open_per_symbol"
  ON "trading_halts" ("symbol")
  WHERE "released_at" IS NULL;
