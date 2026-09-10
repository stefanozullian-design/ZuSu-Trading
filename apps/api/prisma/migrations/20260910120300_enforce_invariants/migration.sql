-- Invariants that Prisma's schema language cannot express.
--
-- These are deliberately enforced by the database rather than by application
-- code: a bug, a console session or a future service must not be able to
-- violate them.

-- ---------------------------------------------------------------------------
-- 1. audit_logs is append-only (§51)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION audit_logs_block_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_logs_no_update
  BEFORE UPDATE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_block_mutation();

CREATE TRIGGER audit_logs_no_delete
  BEFORE DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_block_mutation();

CREATE TRIGGER audit_logs_no_truncate
  BEFORE TRUNCATE ON audit_logs
  EXECUTE FUNCTION audit_logs_block_mutation();

REVOKE UPDATE, DELETE, TRUNCATE ON audit_logs FROM PUBLIC;

-- Every audit row must carry its tamper-evidence hash.
ALTER TABLE audit_logs
  ADD CONSTRAINT audit_logs_hash_not_blank CHECK (length(hash) = 64);

-- ---------------------------------------------------------------------------
-- 2. Environment isolation (§3) — a broker account or order may never belong to
--    a portfolio in a different environment.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION assert_environment_matches_portfolio() RETURNS trigger AS $$
DECLARE
  portfolio_env "TradingEnvironment";
BEGIN
  SELECT environment INTO portfolio_env FROM portfolios WHERE id = NEW.portfolio_id;
  IF portfolio_env IS NULL THEN
    RAISE EXCEPTION 'portfolio % does not exist', NEW.portfolio_id;
  END IF;
  IF NEW.environment <> portfolio_env THEN
    RAISE EXCEPTION
      'environment mismatch on %: row is % but portfolio % is %',
      TG_TABLE_NAME, NEW.environment, NEW.portfolio_id, portfolio_env
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER broker_accounts_environment_guard
  BEFORE INSERT OR UPDATE ON broker_accounts
  FOR EACH ROW EXECUTE FUNCTION assert_environment_matches_portfolio();

CREATE TRIGGER orders_environment_guard
  BEFORE INSERT OR UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION assert_environment_matches_portfolio();

-- An order must also be routed through a broker account in its own environment.
CREATE OR REPLACE FUNCTION assert_order_broker_environment() RETURNS trigger AS $$
DECLARE
  broker_env "TradingEnvironment";
BEGIN
  IF NEW.broker_account_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT environment INTO broker_env FROM broker_accounts WHERE id = NEW.broker_account_id;
  IF broker_env IS DISTINCT FROM NEW.environment THEN
    RAISE EXCEPTION
      'order % targets a % broker account from a % order', NEW.id, broker_env, NEW.environment
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER orders_broker_environment_guard
  BEFORE INSERT OR UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION assert_order_broker_environment();

-- A portfolio's environment is fixed for life.
CREATE OR REPLACE FUNCTION portfolios_environment_is_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW.environment <> OLD.environment THEN
    RAISE EXCEPTION 'a portfolio may not change environment (% -> %)', OLD.environment, NEW.environment
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER portfolios_environment_immutable
  BEFORE UPDATE ON portfolios
  FOR EACH ROW EXECUTE FUNCTION portfolios_environment_is_immutable();

-- ---------------------------------------------------------------------------
-- 3. Strategy versions are immutable once written (§9)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION strategy_versions_block_definition_change() RETURNS trigger AS $$
BEGIN
  IF NEW.definition::text <> OLD.definition::text
     OR NEW.risk_settings::text <> OLD.risk_settings::text
     OR NEW.version <> OLD.version
     OR NEW.strategy_id <> OLD.strategy_id THEN
    RAISE EXCEPTION 'strategy version %/% is immutable; create a new version instead',
      OLD.strategy_id, OLD.version
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER strategy_versions_immutable
  BEFORE UPDATE ON strategy_versions
  FOR EACH ROW EXECUTE FUNCTION strategy_versions_block_definition_change();

-- ---------------------------------------------------------------------------
-- 4. Order and position arithmetic
-- ---------------------------------------------------------------------------

ALTER TABLE orders
  ADD CONSTRAINT orders_requested_qty_positive CHECK (requested_qty > 0),
  ADD CONSTRAINT orders_filled_qty_range CHECK (filled_qty >= 0 AND filled_qty <= requested_qty),
  ADD CONSTRAINT orders_fees_non_negative CHECK (fees_total >= 0);

ALTER TABLE executions
  ADD CONSTRAINT executions_qty_positive CHECK (quantity > 0),
  ADD CONSTRAINT executions_price_positive CHECK (price > 0);

ALTER TABLE position_lots
  ADD CONSTRAINT position_lots_remaining_range CHECK (remaining_qty >= 0 AND remaining_qty <= quantity);

ALTER TABLE portfolios
  ADD CONSTRAINT portfolios_initial_capital_positive CHECK (initial_capital > 0);

-- One OPEN position per symbol per portfolio; closed positions are historical.
CREATE UNIQUE INDEX positions_one_open_per_symbol
  ON positions (portfolio_id, symbol)
  WHERE status = 'OPEN';

-- Only one active risk-limit version per portfolio.
CREATE UNIQUE INDEX risk_limits_one_active_per_portfolio
  ON risk_limits (portfolio_id)
  WHERE is_active;
