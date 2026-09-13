-- Switching a portfolio between practice and paper.
--
-- The binding of a portfolio to one environment is what makes "practice
-- credentials can never place a live order" structural rather than a promise,
-- and it stays: nothing may move to or from LIVE. Between DEMO and PAPER there
-- is no such stake — neither can reach a broker — and the real cost of a
-- switch is to the track record, not to safety.
--
-- That cost is what this column records. A paper portfolio's numbers are worth
-- something because they came from real prices; one that spent its first month
-- on invented ones would carry that fiction into its history silently. The
-- instant of the switch is therefore stored, and performance is measured from
-- it rather than from the beginning of a record that changed meaning halfway
-- through. Nothing earlier is deleted — it is simply no longer counted as
-- though it happened in this environment.

ALTER TABLE "portfolios" ADD COLUMN "environment_changed_at" TIMESTAMP(3);
