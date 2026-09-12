-- Strategy-version guarantees (§10).
--
-- Phase 1 already made every version's definition immutable from the moment it
-- is written (`strategy_versions_immutable`), which is a stronger rule than
-- freezing only approved ones: every change is a new version, with no
-- "editable draft" special case that a later change could widen. These add the
-- guarantees that rule does not cover.

-- ---------------------------------------------------------------------------
-- 1. A version that reached APPROVED must record who approved it and when.
--    An approval nobody signed is not an approval.
-- ---------------------------------------------------------------------------

ALTER TABLE "strategy_versions"
  ADD CONSTRAINT "strategy_versions_approval_is_signed"
  CHECK (
    stage NOT IN ('APPROVED', 'LIVE')
    OR (approved_by_id IS NOT NULL AND approved_at IS NOT NULL)
  );

-- ---------------------------------------------------------------------------
-- 2. At most one LIVE version per strategy. Two live definitions for one
--    strategy would make "which rules are running" unanswerable.
-- ---------------------------------------------------------------------------

CREATE UNIQUE INDEX "strategy_versions_one_live_per_strategy"
  ON "strategy_versions" ("strategy_id")
  WHERE stage = 'LIVE';

-- ---------------------------------------------------------------------------
-- 3. A change description is mandatory and must say something. "update" tells
--    a future reader nothing about why a definition changed, and the lineage
--    of a live strategy is the only record of that reasoning.
-- ---------------------------------------------------------------------------

ALTER TABLE "strategy_versions"
  ADD CONSTRAINT "strategy_versions_change_description_meaningful"
  CHECK (length(btrim(change_description)) >= 8);
