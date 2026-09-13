-- Opening positions: shares a person already held before this platform existed.
--
-- Two additions, both about provenance. A position now records whether it came
-- from a fill this platform can point to (TRADED) or from a person's
-- declaration (IMPORTED) — nothing has to infer it from the absence of an
-- order. And a cash flow can be a transfer of shares rather than of cash, so
-- an opening balance is recorded as a contribution and never read as a gain.

CREATE TYPE "PositionOrigin" AS ENUM ('TRADED', 'IMPORTED');

ALTER TABLE "positions"
  ADD COLUMN "origin" "PositionOrigin" NOT NULL DEFAULT 'TRADED';

ALTER TYPE "CashFlowType" ADD VALUE 'TRANSFER_IN';

-- An imported position must carry a real acquisition date, and a date in the
-- future is a typo rather than a holding.
ALTER TABLE "positions"
  ADD CONSTRAINT "positions_imported_opened_in_the_past"
  CHECK ("origin" <> 'IMPORTED' OR "opened_at" <= now() + interval '1 day');
