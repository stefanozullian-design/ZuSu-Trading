-- A portfolio may move between the two simulated environments, and never
-- to or from LIVE.
--
-- The original rule was that a portfolio's environment is fixed for life, and
-- the reason was a good one: it is what makes "practice credentials can never
-- place a live order" a property of the database rather than a promise made by
-- application code that somebody could later relax.
--
-- That reason applies to exactly one boundary. DEMO and PAPER differ in where
-- their prices come from; neither can reach a broker, neither can move money,
-- and no credential crosses anything when a portfolio moves between them. The
-- cost of such a move is to the portfolio's track record, not to anyone's
-- money — and that cost is handled where it belongs, by recording the instant
-- of the switch and measuring performance from it.
--
-- So the invariant is narrowed rather than dropped. It still refuses, in the
-- database, the only transition that was ever dangerous: anything becoming
-- LIVE, and anything LIVE becoming something else. A live portfolio's record
-- is of real money and real fills, and relabelling it as practice would make a
-- trading record something that can be rewritten.

CREATE OR REPLACE FUNCTION portfolios_environment_is_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW.environment = OLD.environment THEN
    RETURN NEW;
  END IF;

  IF OLD.environment = 'LIVE' OR NEW.environment = 'LIVE' THEN
    RAISE EXCEPTION 'a portfolio may not change environment to or from LIVE (% -> %)',
      OLD.environment, NEW.environment
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
