-- Portfolios belong to a person, and say what they are for.
--
-- The owner (`client_id`) already existed and was never surfaced. What changes
-- here is what a name has to be unique against, and the addition of an
-- objective.
--
-- Name uniqueness was (name, environment) across the whole installation. That
-- is wrong as soon as one person manages money for more than one person: two
-- people can each reasonably have a portfolio called "Retirement", and forcing
-- "Mom — Retirement" makes the owner column decorative. Uniqueness now
-- includes the owner.
--
-- NULLS NOT DISTINCT matters and is the reason this needs PostgreSQL 15 or
-- later. By default PostgreSQL treats every NULL as distinct from every other
-- NULL, so an ordinary unique index would allow any number of unowned
-- portfolios all called "Retirement" — the exact collision this constraint
-- exists to prevent, reintroduced through the back door.

CREATE TYPE "PortfolioObjective" AS ENUM ('DAY_TRADING', 'GROWTH', 'INCOME', 'RETIREMENT');

-- Nullable, with no default. A portfolio created before objectives existed has
-- no stated objective, and writing one in would put a choice nobody made on
-- the screen as though somebody had made it.
ALTER TABLE "portfolios" ADD COLUMN "objective" "PortfolioObjective";

DROP INDEX IF EXISTS "portfolios_name_environment_key";

ALTER TABLE "portfolios"
  ADD CONSTRAINT "portfolios_client_id_name_environment_key"
  UNIQUE NULLS NOT DISTINCT ("client_id", "name", "environment");
