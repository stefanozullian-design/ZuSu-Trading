-- What the watcher has already told you.
--
-- The watcher re-computes a portfolio's findings on a schedule, and without
-- memory it would report the same concentration every time it ran. A person
-- who is told the same thing every hour stops reading any of it, which costs
-- them the one message that was new.
--
-- So each finding is a row with a life: when it was first seen, when it was
-- last seen, and when it stopped being true. A notification is sent on the
-- transitions — it appeared, it cleared — and never on the many runs in
-- between where nothing changed.
--
-- Clearing is worth a message of its own. "Technology is back under its limit"
-- is exactly as useful as the breach was, and a watcher that only ever reports
-- bad news leaves a person unable to tell a fixed problem from an unwatched
-- one.
CREATE TABLE "portfolio_findings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "portfolio_id" UUID NOT NULL,
    -- Stable across runs. This is what makes a repeat a repeat.
    "code" TEXT NOT NULL,
    -- The symbol or sector it is about. Null when it is about the portfolio.
    "subject" TEXT,
    "severity" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- Set when the finding stopped being true. The row is kept either way.
    "resolved_at" TIMESTAMP(3),
    "notified_at" TIMESTAMP(3),

    CONSTRAINT "portfolio_findings_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "portfolio_findings"
  ADD CONSTRAINT "portfolio_findings_portfolio_id_fkey"
  FOREIGN KEY ("portfolio_id") REFERENCES "portfolios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- One live row per finding per portfolio. NULLS NOT DISTINCT because a
-- subject-less finding must collide with itself: without it, every run would
-- insert another "cash is negative" row and the watcher would re-announce it
-- forever, which is the exact failure this table exists to prevent.
CREATE UNIQUE INDEX "portfolio_findings_identity"
  ON "portfolio_findings"("portfolio_id", "code", "subject") NULLS NOT DISTINCT;

CREATE INDEX "portfolio_findings_open"
  ON "portfolio_findings"("portfolio_id", "resolved_at");
