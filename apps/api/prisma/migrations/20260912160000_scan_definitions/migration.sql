-- Saved scanner filters (§9).
--
-- Conditions are JSON rather than a set of columns: a condition is a small
-- open-ended shape ({field, operator, operand}) that will grow, and a column
-- per operand would mean a migration every time. They are validated against a
-- zod schema on the way in, so what comes back out is always readable.

CREATE TABLE "scan_definitions" (
  "id"           UUID NOT NULL,
  "name"         TEXT NOT NULL,
  "description"  TEXT,
  "timeframe"    TEXT NOT NULL,
  "conditions"   JSONB NOT NULL,
  "watchlist_id" UUID,
  "created_by"   UUID,
  "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"   TIMESTAMP(3) NOT NULL,
  "last_run_at"  TIMESTAMP(3),

  CONSTRAINT "scan_definitions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "scan_definitions_name_key" ON "scan_definitions" ("name");

ALTER TABLE "scan_definitions"
  ADD CONSTRAINT "scan_definitions_watchlist_id_fkey"
  FOREIGN KEY ("watchlist_id") REFERENCES "watchlists"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "scan_definitions"
  ADD CONSTRAINT "scan_definitions_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Only timeframes the indicator engine understands.
ALTER TABLE "scan_definitions"
  ADD CONSTRAINT "scan_definitions_timeframe_known"
  CHECK ("timeframe" IN ('1m', '5m', '15m', '1h', '1d'));

-- Conditions must be a JSON array. A scan whose filter is an object or a string
-- could not be evaluated, so it must not be storable.
ALTER TABLE "scan_definitions"
  ADD CONSTRAINT "scan_definitions_conditions_is_array"
  CHECK (jsonb_typeof("conditions") = 'array');
