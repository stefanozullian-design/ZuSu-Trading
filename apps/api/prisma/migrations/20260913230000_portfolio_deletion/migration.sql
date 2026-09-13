-- A portfolio can be deleted; the record that it existed cannot.
--
-- Deleting one was impossible, and not by policy: audit_logs.portfolio_id was
-- a foreign key with ON DELETE SET NULL, and audit_logs refuses UPDATE in a
-- trigger. So the delete asked the database to rewrite an append-only log, and
-- the database said no.
--
-- The foreign key was the wrong tool for this column. An immutable log records
-- what happened, and "this happened to portfolio X" stays true after X is
-- gone; nulling the reference to keep referential integrity would destroy
-- information in order to preserve a constraint about rows that are no longer
-- there. The column stays, keeps its id, and stops being a foreign key.
--
-- The log therefore keeps every entry a deleted portfolio ever produced,
-- including the one written immediately before it went, which names what was
-- deleted and by whom. Tidying a list cannot erase a trading record.

ALTER TABLE "audit_logs" DROP CONSTRAINT IF EXISTS "audit_logs_portfolio_id_fkey";
