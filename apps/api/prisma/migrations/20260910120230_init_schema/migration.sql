-- CreateEnum
CREATE TYPE "TradingEnvironment" AS ENUM ('DEMO', 'PAPER', 'LIVE');

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('ADMIN', 'MANAGER', 'CLIENT', 'VIEWER');

-- CreateEnum
CREATE TYPE "ExecutionMode" AS ENUM ('OBSERVE', 'MANUAL_APPROVAL', 'LIMITED_AUTO', 'FULL_AUTO');

-- CreateEnum
CREATE TYPE "TradingState" AS ENUM ('ACTIVE', 'HALTED', 'RECONCILIATION_ERROR');

-- CreateEnum
CREATE TYPE "AssetClass" AS ENUM ('EQUITY', 'OPTION', 'CRYPTO', 'ETF');

-- CreateEnum
CREATE TYPE "OrderSide" AS ENUM ('BUY', 'SELL');

-- CreateEnum
CREATE TYPE "OrderType" AS ENUM ('MARKET', 'LIMIT', 'STOP', 'STOP_LIMIT');

-- CreateEnum
CREATE TYPE "TimeInForce" AS ENUM ('DAY', 'GTC', 'IOC', 'FOK');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('CREATED', 'SUBMITTED', 'ACKNOWLEDGED', 'PARTIALLY_FILLED', 'FILLED', 'CANCEL_REQUESTED', 'CANCELLED', 'REJECTED', 'EXPIRED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "SignalStatus" AS ENUM ('CREATED', 'ANALYZING', 'RISK_CHECK', 'PENDING_APPROVAL', 'APPROVED', 'ORDER_SUBMITTED', 'PARTIALLY_FILLED', 'FILLED', 'POSITION_OPEN', 'EXIT_PENDING', 'CLOSED', 'REJECTED', 'EXPIRED', 'SKIPPED', 'CANCELLED', 'FAILED');

-- CreateEnum
CREATE TYPE "SignalDirection" AS ENUM ('LONG', 'SHORT');

-- CreateEnum
CREATE TYPE "StrategyStage" AS ENUM ('DRAFT', 'BACKTEST', 'PAPER', 'REVIEW', 'APPROVED', 'LIVE', 'RETIRED');

-- CreateEnum
CREATE TYPE "TradingSessionScope" AS ENUM ('REGULAR_ONLY', 'INCLUDE_PRE_MARKET', 'INCLUDE_AFTER_HOURS', 'ALL_AVAILABLE');

-- CreateEnum
CREATE TYPE "MarketSession" AS ENUM ('CLOSED', 'PRE_MARKET', 'REGULAR', 'AFTER_HOURS', 'HALTED');

-- CreateEnum
CREATE TYPE "MarketRegimeType" AS ENUM ('TRENDING', 'RANGE_BOUND', 'HIGH_VOLATILITY', 'LOW_VOLATILITY', 'BULLISH', 'BEARISH', 'NEUTRAL', 'RISK_ON', 'RISK_OFF');

-- CreateEnum
CREATE TYPE "BrokerKind" AS ENUM ('DEMO', 'PAPER', 'ROBINHOOD');

-- CreateEnum
CREATE TYPE "BrokerConnectionState" AS ENUM ('DISCONNECTED', 'CONNECTED', 'DEGRADED', 'AUTH_FAILED');

-- CreateEnum
CREATE TYPE "PositionStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "RiskEventType" AS ENUM ('LIMIT_BREACH', 'LIMIT_WARNING', 'KILL_SWITCH_MANUAL', 'KILL_SWITCH_AUTOMATIC', 'RECONCILIATION_MISMATCH', 'DATA_QUALITY_HALT', 'BROKER_UNAVAILABLE', 'DRAWDOWN', 'STRATEGY_DEVIATION');

-- CreateEnum
CREATE TYPE "RiskEventSeverity" AS ENUM ('INFO', 'WARNING', 'CRITICAL');

-- CreateEnum
CREATE TYPE "ServiceName" AS ENUM ('MARKET_DATA', 'BROKER', 'CLAUDE', 'DATABASE', 'REDIS', 'SCHEDULER', 'WEBSOCKET', 'RECONCILIATION', 'NOTIFICATIONS');

-- CreateEnum
CREATE TYPE "ServiceStatus" AS ENUM ('HEALTHY', 'DEGRADED', 'DOWN', 'DISABLED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('BROWSER', 'PUSH', 'EMAIL', 'SMS', 'SLACK', 'DISCORD');

-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'SUPPRESSED');

-- CreateEnum
CREATE TYPE "CashFlowType" AS ENUM ('DEPOSIT', 'WITHDRAWAL');

-- CreateEnum
CREATE TYPE "FeeType" AS ENUM ('COMMISSION', 'EXCHANGE', 'REGULATORY', 'CONTRACT', 'MANAGEMENT', 'PERFORMANCE', 'FIXED', 'OTHER');

-- CreateEnum
CREATE TYPE "BacktestStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "DataQualityIssue" AS ENUM ('STALE_QUOTE', 'MISSING_CANDLE', 'ABNORMAL_JUMP', 'DUPLICATE', 'TIMESTAMP_GAP', 'IMPOSSIBLE_SPREAD', 'NON_POSITIVE_PRICE', 'PROVIDER_OUTAGE');

-- CreateEnum
CREATE TYPE "ComplianceDocumentType" AS ENUM ('RISK_DISCLOSURE', 'CLIENT_AGREEMENT', 'FEE_DISCLOSURE', 'TRADING_AUTHORIZATION', 'PRIVACY_POLICY', 'TERMS_OF_USE');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "role" "UserRole" NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "mfa_secret" TEXT,
    "mfa_enabled" BOOLEAN NOT NULL DEFAULT false,
    "mfa_enrolled_at" TIMESTAMP(3),
    "last_login_at" TIMESTAMP(3),
    "failed_logins" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMP(3),
    "client_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "family_id" UUID NOT NULL,
    "issued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "revoked_by" TEXT,
    "replaced_by_id" UUID,
    "ip" TEXT,
    "user_agent" TEXT,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clients" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "external_ref" TEXT,
    "contact_email" TEXT,
    "notes" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "clients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client_portfolios" (
    "id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "portfolio_id" UUID NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "client_portfolios_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "portfolio_access" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "portfolio_id" UUID NOT NULL,
    "can_trade" BOOLEAN NOT NULL DEFAULT false,
    "granted_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "portfolio_access_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "portfolios" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "environment" "TradingEnvironment" NOT NULL,
    "client_id" UUID,
    "base_currency" TEXT NOT NULL DEFAULT 'USD',
    "initial_capital" DECIMAL(24,8) NOT NULL,
    "cash_balance" DECIMAL(24,8) NOT NULL,
    "execution_mode" "ExecutionMode" NOT NULL DEFAULT 'MANUAL_APPROVAL',
    "trading_state" "TradingState" NOT NULL DEFAULT 'ACTIVE',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "halted_reason" TEXT,
    "halted_at" TIMESTAMP(3),
    "timezone" TEXT NOT NULL DEFAULT 'America/New_York',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "portfolios_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "broker_accounts" (
    "id" UUID NOT NULL,
    "portfolio_id" UUID NOT NULL,
    "environment" "TradingEnvironment" NOT NULL,
    "broker" "BrokerKind" NOT NULL,
    "label" TEXT NOT NULL,
    "external_account_id" TEXT,
    "credentials_enc" TEXT,
    "connection_state" "BrokerConnectionState" NOT NULL DEFAULT 'DISCONNECTED',
    "last_connected_at" TIMESTAMP(3),
    "last_error_at" TIMESTAMP(3),
    "last_error" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "broker_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "instruments" (
    "id" UUID NOT NULL,
    "symbol" TEXT NOT NULL,
    "name" TEXT,
    "asset_class" "AssetClass" NOT NULL DEFAULT 'EQUITY',
    "exchange" TEXT,
    "sector" TEXT,
    "industry" TEXT,
    "beta" DECIMAL(12,6),
    "is_tradable" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "instruments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "market_data_quotes" (
    "id" UUID NOT NULL,
    "instrument_id" UUID NOT NULL,
    "symbol" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "price" DECIMAL(24,8) NOT NULL,
    "bid" DECIMAL(24,8),
    "ask" DECIMAL(24,8),
    "bid_size" DECIMAL(24,8),
    "ask_size" DECIMAL(24,8),
    "volume" DECIMAL(24,8),
    "source_timestamp" TIMESTAMP(3) NOT NULL,
    "received_timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "market_session" "MarketSession" NOT NULL,
    "is_stale" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "market_data_quotes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "market_data_candles" (
    "id" UUID NOT NULL,
    "instrument_id" UUID NOT NULL,
    "symbol" TEXT NOT NULL,
    "timeframe" TEXT NOT NULL,
    "open_time" TIMESTAMP(3) NOT NULL,
    "close_time" TIMESTAMP(3) NOT NULL,
    "open" DECIMAL(24,8) NOT NULL,
    "high" DECIMAL(24,8) NOT NULL,
    "low" DECIMAL(24,8) NOT NULL,
    "close" DECIMAL(24,8) NOT NULL,
    "volume" DECIMAL(24,8) NOT NULL,
    "vwap" DECIMAL(24,8),
    "trade_count" INTEGER,
    "provider" TEXT NOT NULL,
    "is_adjusted" BOOLEAN NOT NULL DEFAULT false,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "market_data_candles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "market_data_quality_events" (
    "id" UUID NOT NULL,
    "instrument_id" UUID,
    "symbol" TEXT,
    "provider" TEXT NOT NULL,
    "issue" "DataQualityIssue" NOT NULL,
    "detail" TEXT NOT NULL,
    "blocking" BOOLEAN NOT NULL DEFAULT false,
    "detected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),

    CONSTRAINT "market_data_quality_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "market_calendar_days" (
    "id" UUID NOT NULL,
    "market_code" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "is_trading_day" BOOLEAN NOT NULL,
    "pre_market_open" TIMESTAMP(3),
    "regular_open" TIMESTAMP(3),
    "regular_close" TIMESTAMP(3),
    "after_hours_close" TIMESTAMP(3),
    "is_early_close" BOOLEAN NOT NULL DEFAULT false,
    "holiday_name" TEXT,

    CONSTRAINT "market_calendar_days_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "market_regimes" (
    "id" UUID NOT NULL,
    "market_code" TEXT NOT NULL DEFAULT 'XNYS',
    "symbol" TEXT,
    "regime" "MarketRegimeType" NOT NULL,
    "confidence" DECIMAL(8,6) NOT NULL,
    "inputs" JSONB NOT NULL,
    "detected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "valid_until" TIMESTAMP(3),

    CONSTRAINT "market_regimes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "option_contracts" (
    "id" UUID NOT NULL,
    "underlying_id" UUID NOT NULL,
    "occ_symbol" TEXT NOT NULL,
    "expiration" DATE NOT NULL,
    "strike" DECIMAL(24,8) NOT NULL,
    "is_call" BOOLEAN NOT NULL,
    "bid" DECIMAL(24,8),
    "ask" DECIMAL(24,8),
    "open_interest" INTEGER,
    "volume" INTEGER,
    "implied_vol" DECIMAL(12,8),
    "delta" DECIMAL(12,8),
    "gamma" DECIMAL(12,8),
    "theta" DECIMAL(12,8),
    "vega" DECIMAL(12,8),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "option_contracts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "watchlists" (
    "id" UUID NOT NULL,
    "portfolio_id" UUID,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "watchlists_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "watchlist_items" (
    "id" UUID NOT NULL,
    "watchlist_id" UUID NOT NULL,
    "instrument_id" UUID NOT NULL,
    "added_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "watchlist_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "strategies" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "is_archived" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "strategies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "strategy_versions" (
    "id" UUID NOT NULL,
    "strategy_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "stage" "StrategyStage" NOT NULL DEFAULT 'DRAFT',
    "author_id" UUID,
    "change_description" TEXT NOT NULL,
    "previous_version_id" UUID,
    "definition" JSONB NOT NULL,
    "risk_settings" JSONB NOT NULL,
    "execution_mode" "ExecutionMode" NOT NULL DEFAULT 'MANUAL_APPROVAL',
    "session_scope" "TradingSessionScope" NOT NULL DEFAULT 'REGULAR_ONLY',
    "allowed_regimes" JSONB,
    "requires_ai" BOOLEAN NOT NULL DEFAULT false,
    "approved_by_id" UUID,
    "approved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "strategy_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "strategy_portfolio_configs" (
    "id" UUID NOT NULL,
    "strategy_id" UUID NOT NULL,
    "strategy_version_id" UUID NOT NULL,
    "portfolio_id" UUID NOT NULL,
    "is_enabled" BOOLEAN NOT NULL DEFAULT false,
    "execution_mode" "ExecutionMode" NOT NULL DEFAULT 'MANUAL_APPROVAL',
    "scan_interval_sec" INTEGER NOT NULL DEFAULT 300,
    "position_sizing" JSONB NOT NULL,
    "overrides" JSONB,
    "enabled_at" TIMESTAMP(3),
    "disabled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "strategy_portfolio_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "signals" (
    "id" UUID NOT NULL,
    "signal_key" TEXT NOT NULL,
    "correlation_id" UUID NOT NULL,
    "portfolio_id" UUID NOT NULL,
    "strategy_id" UUID,
    "strategy_version_id" UUID,
    "symbol" TEXT NOT NULL,
    "asset_class" "AssetClass" NOT NULL DEFAULT 'EQUITY',
    "direction" "SignalDirection" NOT NULL,
    "status" "SignalStatus" NOT NULL DEFAULT 'CREATED',
    "technical_score" DECIMAL(8,4),
    "reference_price" DECIMAL(24,8) NOT NULL,
    "suggested_stop" DECIMAL(24,8),
    "suggested_target" DECIMAL(24,8),
    "quantity" DECIMAL(24,8),
    "notional" DECIMAL(24,8),
    "max_loss" DECIMAL(24,8),
    "market_regime" "MarketRegimeType",
    "condition_snapshot" JSONB NOT NULL,
    "rejection_reason" TEXT,
    "expires_at" TIMESTAMP(3),
    "approved_by_id" UUID,
    "approved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "signals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "signal_events" (
    "id" UUID NOT NULL,
    "signal_id" UUID NOT NULL,
    "from_status" "SignalStatus",
    "to_status" "SignalStatus" NOT NULL,
    "reason" TEXT,
    "actor" TEXT NOT NULL,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "signal_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" UUID NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "correlation_id" UUID NOT NULL,
    "portfolio_id" UUID NOT NULL,
    "broker_account_id" UUID,
    "signal_id" UUID,
    "strategy_id" UUID,
    "environment" "TradingEnvironment" NOT NULL,
    "broker_order_id" TEXT,
    "symbol" TEXT NOT NULL,
    "asset_class" "AssetClass" NOT NULL DEFAULT 'EQUITY',
    "side" "OrderSide" NOT NULL,
    "order_type" "OrderType" NOT NULL,
    "time_in_force" "TimeInForce" NOT NULL DEFAULT 'DAY',
    "status" "OrderStatus" NOT NULL DEFAULT 'CREATED',
    "requested_qty" DECIMAL(24,8) NOT NULL,
    "filled_qty" DECIMAL(24,8) NOT NULL DEFAULT 0,
    "limit_price" DECIMAL(24,8),
    "stop_price" DECIMAL(24,8),
    "expected_price" DECIMAL(24,8),
    "average_fill_price" DECIMAL(24,8),
    "slippage" DECIMAL(24,8),
    "slippage_pct" DECIMAL(12,8),
    "fees_total" DECIMAL(24,8) NOT NULL DEFAULT 0,
    "rejection_reason" TEXT,
    "broker_response" JSONB,
    "submitted_at" TIMESTAMP(3),
    "acknowledged_at" TIMESTAMP(3),
    "filled_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "last_synced_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_events" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "from_status" "OrderStatus",
    "to_status" "OrderStatus" NOT NULL,
    "reason" TEXT,
    "actor" TEXT NOT NULL,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "executions" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "portfolio_id" UUID NOT NULL,
    "broker_exec_id" TEXT,
    "symbol" TEXT NOT NULL,
    "side" "OrderSide" NOT NULL,
    "quantity" DECIMAL(24,8) NOT NULL,
    "price" DECIMAL(24,8) NOT NULL,
    "fees" DECIMAL(24,8) NOT NULL DEFAULT 0,
    "executed_at" TIMESTAMP(3) NOT NULL,
    "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "liquidity_flag" TEXT,

    CONSTRAINT "executions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "positions" (
    "id" UUID NOT NULL,
    "portfolio_id" UUID NOT NULL,
    "symbol" TEXT NOT NULL,
    "asset_class" "AssetClass" NOT NULL DEFAULT 'EQUITY',
    "status" "PositionStatus" NOT NULL DEFAULT 'OPEN',
    "quantity" DECIMAL(24,8) NOT NULL,
    "average_entry_price" DECIMAL(24,8) NOT NULL,
    "mark_price" DECIMAL(24,8),
    "realized_pnl" DECIMAL(24,8) NOT NULL DEFAULT 0,
    "unrealized_pnl" DECIMAL(24,8) NOT NULL DEFAULT 0,
    "fees_total" DECIMAL(24,8) NOT NULL DEFAULT 0,
    "stop_price" DECIMAL(24,8),
    "target_price" DECIMAL(24,8),
    "mae_amount" DECIMAL(24,8),
    "mfe_amount" DECIMAL(24,8),
    "opened_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMP(3),
    "last_reconciled_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "positions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "position_lots" (
    "id" UUID NOT NULL,
    "position_id" UUID NOT NULL,
    "execution_id" UUID,
    "quantity" DECIMAL(24,8) NOT NULL,
    "remaining_qty" DECIMAL(24,8) NOT NULL,
    "cost_basis" DECIMAL(24,8) NOT NULL,
    "opened_at" TIMESTAMP(3) NOT NULL,
    "closed_at" TIMESTAMP(3),
    "realized_gain" DECIMAL(24,8) NOT NULL DEFAULT 0,

    CONSTRAINT "position_lots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reconciliations" (
    "id" UUID NOT NULL,
    "broker_account_id" UUID NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),
    "succeeded" BOOLEAN NOT NULL DEFAULT false,
    "cash_mismatch" BOOLEAN NOT NULL DEFAULT false,
    "position_mismatch" BOOLEAN NOT NULL DEFAULT false,
    "order_mismatch" BOOLEAN NOT NULL DEFAULT false,
    "differences" JSONB,
    "detail" TEXT,

    CONSTRAINT "reconciliations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "risk_limits" (
    "id" UUID NOT NULL,
    "portfolio_id" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "max_daily_loss" DECIMAL(24,8) NOT NULL,
    "max_weekly_loss" DECIMAL(24,8) NOT NULL,
    "max_position_size" DECIMAL(24,8) NOT NULL,
    "max_portfolio_exposure_pct" DECIMAL(12,6) NOT NULL,
    "max_sector_exposure_pct" DECIMAL(12,6) NOT NULL,
    "max_symbol_exposure_pct" DECIMAL(12,6) NOT NULL,
    "max_open_positions" INTEGER NOT NULL,
    "max_trades_per_day" INTEGER NOT NULL,
    "max_consecutive_losses" INTEGER NOT NULL,
    "max_drawdown_pct" DECIMAL(12,6) NOT NULL,
    "changed_by_id" UUID,
    "change_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "risk_limits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "risk_events" (
    "id" UUID NOT NULL,
    "portfolio_id" UUID,
    "signal_id" UUID,
    "type" "RiskEventType" NOT NULL,
    "severity" "RiskEventSeverity" NOT NULL DEFAULT 'WARNING',
    "message" TEXT NOT NULL,
    "limit_name" TEXT,
    "limit_value" DECIMAL(24,8),
    "actual_value" DECIMAL(24,8),
    "metadata" JSONB,
    "resolved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "risk_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "portfolio_snapshots" (
    "id" UUID NOT NULL,
    "portfolio_id" UUID NOT NULL,
    "as_of" TIMESTAMP(3) NOT NULL,
    "cash_balance" DECIMAL(24,8) NOT NULL,
    "positions_value" DECIMAL(24,8) NOT NULL,
    "equity" DECIMAL(24,8) NOT NULL,
    "net_cash_flow" DECIMAL(24,8) NOT NULL DEFAULT 0,
    "realized_pnl" DECIMAL(24,8) NOT NULL DEFAULT 0,
    "unrealized_pnl" DECIMAL(24,8) NOT NULL DEFAULT 0,
    "fees_total" DECIMAL(24,8) NOT NULL DEFAULT 0,
    "open_positions" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "portfolio_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "performance_metrics" (
    "id" UUID NOT NULL,
    "portfolio_id" UUID NOT NULL,
    "strategy_id" UUID,
    "period" TEXT NOT NULL,
    "period_start" TIMESTAMP(3) NOT NULL,
    "period_end" TIMESTAMP(3) NOT NULL,
    "gross_pnl" DECIMAL(24,8) NOT NULL,
    "fees" DECIMAL(24,8) NOT NULL,
    "net_pnl" DECIMAL(24,8) NOT NULL,
    "time_weighted_return" DECIMAL(16,8),
    "money_weighted_return" DECIMAL(16,8),
    "max_drawdown_pct" DECIMAL(12,6),
    "sharpe" DECIMAL(12,6),
    "sortino" DECIMAL(12,6),
    "calmar" DECIMAL(12,6),
    "win_rate" DECIMAL(8,6),
    "profit_factor" DECIMAL(12,6),
    "expectancy" DECIMAL(24,8),
    "trade_count" INTEGER NOT NULL DEFAULT 0,
    "computed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "performance_metrics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fees" (
    "id" UUID NOT NULL,
    "portfolio_id" UUID NOT NULL,
    "order_id" UUID,
    "type" "FeeType" NOT NULL,
    "amount" DECIMAL(24,8) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "description" TEXT,
    "high_water_mark" DECIMAL(24,8),
    "hurdle_rate_pct" DECIMAL(12,6),
    "incurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fees_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cash_flows" (
    "id" UUID NOT NULL,
    "portfolio_id" UUID NOT NULL,
    "type" "CashFlowType" NOT NULL,
    "amount" DECIMAL(24,8) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "reference" TEXT,
    "note" TEXT,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cash_flows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_analyses" (
    "id" UUID NOT NULL,
    "portfolio_id" UUID,
    "signal_id" UUID,
    "correlation_id" UUID,
    "model" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "request_payload" JSONB NOT NULL,
    "response_payload" JSONB,
    "response_valid" BOOLEAN NOT NULL DEFAULT false,
    "validation_error" TEXT,
    "action" TEXT,
    "confidence" DECIMAL(8,6),
    "risk_level" TEXT,
    "market_regime" "MarketRegimeType",
    "input_tokens" INTEGER,
    "output_tokens" INTEGER,
    "cost_usd" DECIMAL(16,8),
    "latency_ms" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_analyses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "backtests" (
    "id" UUID NOT NULL,
    "portfolio_id" UUID,
    "strategy_id" UUID NOT NULL,
    "strategy_version_id" UUID NOT NULL,
    "requested_by_id" UUID,
    "status" "BacktestStatus" NOT NULL DEFAULT 'QUEUED',
    "timeframe" TEXT NOT NULL,
    "start_date" TIMESTAMP(3) NOT NULL,
    "end_date" TIMESTAMP(3) NOT NULL,
    "initial_capital" DECIMAL(24,8) NOT NULL,
    "parameters" JSONB NOT NULL,
    "results" JSONB,
    "error_message" TEXT,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "backtests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "backtest_trades" (
    "id" UUID NOT NULL,
    "backtest_id" UUID NOT NULL,
    "symbol" TEXT NOT NULL,
    "direction" "SignalDirection" NOT NULL,
    "quantity" DECIMAL(24,8) NOT NULL,
    "entry_time" TIMESTAMP(3) NOT NULL,
    "entry_price" DECIMAL(24,8) NOT NULL,
    "exit_time" TIMESTAMP(3),
    "exit_price" DECIMAL(24,8),
    "gross_pnl" DECIMAL(24,8),
    "fees" DECIMAL(24,8) NOT NULL DEFAULT 0,
    "slippage" DECIMAL(24,8) NOT NULL DEFAULT 0,
    "net_pnl" DECIMAL(24,8),
    "r_multiple" DECIMAL(12,6),
    "mae_amount" DECIMAL(24,8),
    "mfe_amount" DECIMAL(24,8),
    "exit_reason" TEXT,
    "market_regime" "MarketRegimeType",

    CONSTRAINT "backtest_trades_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "paper_trades" (
    "id" UUID NOT NULL,
    "portfolio_id" UUID NOT NULL,
    "order_id" UUID,
    "symbol" TEXT NOT NULL,
    "side" "OrderSide" NOT NULL,
    "quantity" DECIMAL(24,8) NOT NULL,
    "requested_price" DECIMAL(24,8),
    "fill_price" DECIMAL(24,8) NOT NULL,
    "spread_cost" DECIMAL(24,8) NOT NULL DEFAULT 0,
    "slippage" DECIMAL(24,8) NOT NULL DEFAULT 0,
    "commission" DECIMAL(24,8) NOT NULL DEFAULT 0,
    "latency_ms" INTEGER NOT NULL DEFAULT 0,
    "filled_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "paper_trades_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trade_journal_entries" (
    "id" UUID NOT NULL,
    "portfolio_id" UUID NOT NULL,
    "position_id" UUID,
    "signal_id" UUID,
    "author_id" UUID,
    "entry_thesis" TEXT,
    "technical_context" JSONB,
    "ai_reasoning" TEXT,
    "market_regime" "MarketRegimeType",
    "outcome" TEXT,
    "lessons" TEXT,
    "user_notes" TEXT,
    "chart_snapshot_url" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "trade_journal_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_health_checks" (
    "id" UUID NOT NULL,
    "service" "ServiceName" NOT NULL,
    "status" "ServiceStatus" NOT NULL,
    "latency_ms" INTEGER,
    "detail" TEXT,
    "failure_streak" INTEGER NOT NULL DEFAULT 0,
    "checked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "system_health_checks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "user_id" UUID,
    "portfolio_id" UUID,
    "channel" "NotificationChannel" NOT NULL,
    "status" "NotificationStatus" NOT NULL DEFAULT 'PENDING',
    "event" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "metadata" JSONB,
    "sent_at" TIMESTAMP(3),
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reports" (
    "id" UUID NOT NULL,
    "portfolio_id" UUID,
    "client_id" UUID,
    "kind" TEXT NOT NULL,
    "period_start" TIMESTAMP(3) NOT NULL,
    "period_end" TIMESTAMP(3) NOT NULL,
    "format" TEXT NOT NULL DEFAULT 'PDF',
    "storage_key" TEXT,
    "payload" JSONB,
    "generated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compliance_documents" (
    "id" UUID NOT NULL,
    "type" "ComplianceDocumentType" NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "effective_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "compliance_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client_consents" (
    "id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "accepted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ip" TEXT,
    "user_agent" TEXT,

    CONSTRAINT "client_consents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "seq" BIGSERIAL NOT NULL,
    "id" UUID NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_user_id" UUID,
    "actor_type" TEXT NOT NULL DEFAULT 'USER',
    "actor_label" TEXT,
    "action" TEXT NOT NULL,
    "entity_type" TEXT,
    "entity_id" TEXT,
    "portfolio_id" UUID,
    "client_id" UUID,
    "correlation_id" TEXT,
    "environment" "TradingEnvironment",
    "before_value" JSONB,
    "after_value" JSONB,
    "metadata" JSONB,
    "ip" TEXT,
    "user_agent" TEXT,
    "session_id" TEXT,
    "prev_hash" TEXT,
    "hash" TEXT NOT NULL,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("seq")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_role_idx" ON "users"("role");

-- CreateIndex
CREATE INDEX "users_client_id_idx" ON "users"("client_id");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "refresh_tokens_user_id_idx" ON "refresh_tokens"("user_id");

-- CreateIndex
CREATE INDEX "refresh_tokens_family_id_idx" ON "refresh_tokens"("family_id");

-- CreateIndex
CREATE INDEX "refresh_tokens_expires_at_idx" ON "refresh_tokens"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "clients_external_ref_key" ON "clients"("external_ref");

-- CreateIndex
CREATE INDEX "clients_name_idx" ON "clients"("name");

-- CreateIndex
CREATE INDEX "client_portfolios_portfolio_id_idx" ON "client_portfolios"("portfolio_id");

-- CreateIndex
CREATE UNIQUE INDEX "client_portfolios_client_id_portfolio_id_key" ON "client_portfolios"("client_id", "portfolio_id");

-- CreateIndex
CREATE INDEX "portfolio_access_portfolio_id_idx" ON "portfolio_access"("portfolio_id");

-- CreateIndex
CREATE UNIQUE INDEX "portfolio_access_user_id_portfolio_id_key" ON "portfolio_access"("user_id", "portfolio_id");

-- CreateIndex
CREATE INDEX "portfolios_environment_idx" ON "portfolios"("environment");

-- CreateIndex
CREATE INDEX "portfolios_client_id_idx" ON "portfolios"("client_id");

-- CreateIndex
CREATE INDEX "portfolios_trading_state_idx" ON "portfolios"("trading_state");

-- CreateIndex
CREATE UNIQUE INDEX "portfolios_name_environment_key" ON "portfolios"("name", "environment");

-- CreateIndex
CREATE INDEX "broker_accounts_portfolio_id_idx" ON "broker_accounts"("portfolio_id");

-- CreateIndex
CREATE INDEX "broker_accounts_environment_broker_idx" ON "broker_accounts"("environment", "broker");

-- CreateIndex
CREATE UNIQUE INDEX "instruments_symbol_key" ON "instruments"("symbol");

-- CreateIndex
CREATE INDEX "instruments_sector_idx" ON "instruments"("sector");

-- CreateIndex
CREATE INDEX "market_data_quotes_symbol_source_timestamp_idx" ON "market_data_quotes"("symbol", "source_timestamp");

-- CreateIndex
CREATE INDEX "market_data_quotes_instrument_id_source_timestamp_idx" ON "market_data_quotes"("instrument_id", "source_timestamp");

-- CreateIndex
CREATE INDEX "market_data_candles_symbol_timeframe_open_time_idx" ON "market_data_candles"("symbol", "timeframe", "open_time");

-- CreateIndex
CREATE UNIQUE INDEX "market_data_candles_instrument_id_timeframe_open_time_key" ON "market_data_candles"("instrument_id", "timeframe", "open_time");

-- CreateIndex
CREATE INDEX "market_data_quality_events_detected_at_idx" ON "market_data_quality_events"("detected_at");

-- CreateIndex
CREATE INDEX "market_data_quality_events_issue_idx" ON "market_data_quality_events"("issue");

-- CreateIndex
CREATE UNIQUE INDEX "market_calendar_days_market_code_date_key" ON "market_calendar_days"("market_code", "date");

-- CreateIndex
CREATE INDEX "market_regimes_market_code_detected_at_idx" ON "market_regimes"("market_code", "detected_at");

-- CreateIndex
CREATE UNIQUE INDEX "option_contracts_occ_symbol_key" ON "option_contracts"("occ_symbol");

-- CreateIndex
CREATE INDEX "option_contracts_underlying_id_expiration_idx" ON "option_contracts"("underlying_id", "expiration");

-- CreateIndex
CREATE INDEX "watchlists_portfolio_id_idx" ON "watchlists"("portfolio_id");

-- CreateIndex
CREATE UNIQUE INDEX "watchlist_items_watchlist_id_instrument_id_key" ON "watchlist_items"("watchlist_id", "instrument_id");

-- CreateIndex
CREATE UNIQUE INDEX "strategies_name_key" ON "strategies"("name");

-- CreateIndex
CREATE INDEX "strategy_versions_stage_idx" ON "strategy_versions"("stage");

-- CreateIndex
CREATE UNIQUE INDEX "strategy_versions_strategy_id_version_key" ON "strategy_versions"("strategy_id", "version");

-- CreateIndex
CREATE INDEX "strategy_portfolio_configs_strategy_version_id_idx" ON "strategy_portfolio_configs"("strategy_version_id");

-- CreateIndex
CREATE UNIQUE INDEX "strategy_portfolio_configs_portfolio_id_strategy_id_key" ON "strategy_portfolio_configs"("portfolio_id", "strategy_id");

-- CreateIndex
CREATE UNIQUE INDEX "signals_signal_key_key" ON "signals"("signal_key");

-- CreateIndex
CREATE INDEX "signals_portfolio_id_status_idx" ON "signals"("portfolio_id", "status");

-- CreateIndex
CREATE INDEX "signals_symbol_created_at_idx" ON "signals"("symbol", "created_at");

-- CreateIndex
CREATE INDEX "signals_correlation_id_idx" ON "signals"("correlation_id");

-- CreateIndex
CREATE INDEX "signal_events_signal_id_created_at_idx" ON "signal_events"("signal_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "orders_idempotency_key_key" ON "orders"("idempotency_key");

-- CreateIndex
CREATE INDEX "orders_portfolio_id_status_idx" ON "orders"("portfolio_id", "status");

-- CreateIndex
CREATE INDEX "orders_broker_order_id_idx" ON "orders"("broker_order_id");

-- CreateIndex
CREATE INDEX "orders_correlation_id_idx" ON "orders"("correlation_id");

-- CreateIndex
CREATE INDEX "orders_symbol_created_at_idx" ON "orders"("symbol", "created_at");

-- CreateIndex
CREATE INDEX "order_events_order_id_created_at_idx" ON "order_events"("order_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "executions_broker_exec_id_key" ON "executions"("broker_exec_id");

-- CreateIndex
CREATE INDEX "executions_order_id_idx" ON "executions"("order_id");

-- CreateIndex
CREATE INDEX "executions_portfolio_id_executed_at_idx" ON "executions"("portfolio_id", "executed_at");

-- CreateIndex
CREATE INDEX "positions_portfolio_id_status_idx" ON "positions"("portfolio_id", "status");

-- CreateIndex
CREATE INDEX "positions_portfolio_id_symbol_idx" ON "positions"("portfolio_id", "symbol");

-- CreateIndex
CREATE INDEX "position_lots_position_id_idx" ON "position_lots"("position_id");

-- CreateIndex
CREATE INDEX "reconciliations_broker_account_id_started_at_idx" ON "reconciliations"("broker_account_id", "started_at");

-- CreateIndex
CREATE INDEX "risk_limits_portfolio_id_is_active_idx" ON "risk_limits"("portfolio_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "risk_limits_portfolio_id_version_key" ON "risk_limits"("portfolio_id", "version");

-- CreateIndex
CREATE INDEX "risk_events_portfolio_id_created_at_idx" ON "risk_events"("portfolio_id", "created_at");

-- CreateIndex
CREATE INDEX "risk_events_type_idx" ON "risk_events"("type");

-- CreateIndex
CREATE INDEX "portfolio_snapshots_portfolio_id_as_of_idx" ON "portfolio_snapshots"("portfolio_id", "as_of");

-- CreateIndex
CREATE UNIQUE INDEX "portfolio_snapshots_portfolio_id_as_of_key" ON "portfolio_snapshots"("portfolio_id", "as_of");

-- CreateIndex
CREATE INDEX "performance_metrics_portfolio_id_period_idx" ON "performance_metrics"("portfolio_id", "period");

-- CreateIndex
CREATE UNIQUE INDEX "performance_metrics_portfolio_id_strategy_id_period_period__key" ON "performance_metrics"("portfolio_id", "strategy_id", "period", "period_start");

-- CreateIndex
CREATE INDEX "fees_portfolio_id_incurred_at_idx" ON "fees"("portfolio_id", "incurred_at");

-- CreateIndex
CREATE INDEX "cash_flows_portfolio_id_occurred_at_idx" ON "cash_flows"("portfolio_id", "occurred_at");

-- CreateIndex
CREATE INDEX "ai_analyses_portfolio_id_created_at_idx" ON "ai_analyses"("portfolio_id", "created_at");

-- CreateIndex
CREATE INDEX "ai_analyses_signal_id_idx" ON "ai_analyses"("signal_id");

-- CreateIndex
CREATE INDEX "backtests_strategy_id_status_idx" ON "backtests"("strategy_id", "status");

-- CreateIndex
CREATE INDEX "backtest_trades_backtest_id_idx" ON "backtest_trades"("backtest_id");

-- CreateIndex
CREATE INDEX "paper_trades_portfolio_id_filled_at_idx" ON "paper_trades"("portfolio_id", "filled_at");

-- CreateIndex
CREATE INDEX "trade_journal_entries_portfolio_id_created_at_idx" ON "trade_journal_entries"("portfolio_id", "created_at");

-- CreateIndex
CREATE INDEX "system_health_checks_service_checked_at_idx" ON "system_health_checks"("service", "checked_at");

-- CreateIndex
CREATE INDEX "notifications_user_id_created_at_idx" ON "notifications"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "notifications_status_idx" ON "notifications"("status");

-- CreateIndex
CREATE INDEX "reports_portfolio_id_period_start_idx" ON "reports"("portfolio_id", "period_start");

-- CreateIndex
CREATE UNIQUE INDEX "compliance_documents_type_version_key" ON "compliance_documents"("type", "version");

-- CreateIndex
CREATE UNIQUE INDEX "client_consents_client_id_document_id_key" ON "client_consents"("client_id", "document_id");

-- CreateIndex
CREATE UNIQUE INDEX "audit_logs_id_key" ON "audit_logs"("id");

-- CreateIndex
CREATE INDEX "audit_logs_occurred_at_idx" ON "audit_logs"("occurred_at");

-- CreateIndex
CREATE INDEX "audit_logs_action_occurred_at_idx" ON "audit_logs"("action", "occurred_at");

-- CreateIndex
CREATE INDEX "audit_logs_portfolio_id_occurred_at_idx" ON "audit_logs"("portfolio_id", "occurred_at");

-- CreateIndex
CREATE INDEX "audit_logs_actor_user_id_occurred_at_idx" ON "audit_logs"("actor_user_id", "occurred_at");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_portfolios" ADD CONSTRAINT "client_portfolios_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_portfolios" ADD CONSTRAINT "client_portfolios_portfolio_id_fkey" FOREIGN KEY ("portfolio_id") REFERENCES "portfolios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "portfolio_access" ADD CONSTRAINT "portfolio_access_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "portfolio_access" ADD CONSTRAINT "portfolio_access_granted_by_id_fkey" FOREIGN KEY ("granted_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "portfolio_access" ADD CONSTRAINT "portfolio_access_portfolio_id_fkey" FOREIGN KEY ("portfolio_id") REFERENCES "portfolios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "portfolios" ADD CONSTRAINT "portfolios_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "broker_accounts" ADD CONSTRAINT "broker_accounts_portfolio_id_fkey" FOREIGN KEY ("portfolio_id") REFERENCES "portfolios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "market_data_quotes" ADD CONSTRAINT "market_data_quotes_instrument_id_fkey" FOREIGN KEY ("instrument_id") REFERENCES "instruments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "market_data_candles" ADD CONSTRAINT "market_data_candles_instrument_id_fkey" FOREIGN KEY ("instrument_id") REFERENCES "instruments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "market_data_quality_events" ADD CONSTRAINT "market_data_quality_events_instrument_id_fkey" FOREIGN KEY ("instrument_id") REFERENCES "instruments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "option_contracts" ADD CONSTRAINT "option_contracts_underlying_id_fkey" FOREIGN KEY ("underlying_id") REFERENCES "instruments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "watchlists" ADD CONSTRAINT "watchlists_portfolio_id_fkey" FOREIGN KEY ("portfolio_id") REFERENCES "portfolios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "watchlist_items" ADD CONSTRAINT "watchlist_items_watchlist_id_fkey" FOREIGN KEY ("watchlist_id") REFERENCES "watchlists"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "watchlist_items" ADD CONSTRAINT "watchlist_items_instrument_id_fkey" FOREIGN KEY ("instrument_id") REFERENCES "instruments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "strategy_versions" ADD CONSTRAINT "strategy_versions_strategy_id_fkey" FOREIGN KEY ("strategy_id") REFERENCES "strategies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "strategy_versions" ADD CONSTRAINT "strategy_versions_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "strategy_versions" ADD CONSTRAINT "strategy_versions_approved_by_id_fkey" FOREIGN KEY ("approved_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "strategy_versions" ADD CONSTRAINT "strategy_versions_previous_version_id_fkey" FOREIGN KEY ("previous_version_id") REFERENCES "strategy_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "strategy_portfolio_configs" ADD CONSTRAINT "strategy_portfolio_configs_strategy_id_fkey" FOREIGN KEY ("strategy_id") REFERENCES "strategies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "strategy_portfolio_configs" ADD CONSTRAINT "strategy_portfolio_configs_strategy_version_id_fkey" FOREIGN KEY ("strategy_version_id") REFERENCES "strategy_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "strategy_portfolio_configs" ADD CONSTRAINT "strategy_portfolio_configs_portfolio_id_fkey" FOREIGN KEY ("portfolio_id") REFERENCES "portfolios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signals" ADD CONSTRAINT "signals_portfolio_id_fkey" FOREIGN KEY ("portfolio_id") REFERENCES "portfolios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signals" ADD CONSTRAINT "signals_strategy_id_fkey" FOREIGN KEY ("strategy_id") REFERENCES "strategies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signals" ADD CONSTRAINT "signals_strategy_version_id_fkey" FOREIGN KEY ("strategy_version_id") REFERENCES "strategy_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signals" ADD CONSTRAINT "signals_approved_by_id_fkey" FOREIGN KEY ("approved_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signal_events" ADD CONSTRAINT "signal_events_signal_id_fkey" FOREIGN KEY ("signal_id") REFERENCES "signals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_portfolio_id_fkey" FOREIGN KEY ("portfolio_id") REFERENCES "portfolios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_broker_account_id_fkey" FOREIGN KEY ("broker_account_id") REFERENCES "broker_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_signal_id_fkey" FOREIGN KEY ("signal_id") REFERENCES "signals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "executions" ADD CONSTRAINT "executions_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "executions" ADD CONSTRAINT "executions_portfolio_id_fkey" FOREIGN KEY ("portfolio_id") REFERENCES "portfolios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "positions" ADD CONSTRAINT "positions_portfolio_id_fkey" FOREIGN KEY ("portfolio_id") REFERENCES "portfolios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "position_lots" ADD CONSTRAINT "position_lots_position_id_fkey" FOREIGN KEY ("position_id") REFERENCES "positions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "position_lots" ADD CONSTRAINT "position_lots_execution_id_fkey" FOREIGN KEY ("execution_id") REFERENCES "executions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reconciliations" ADD CONSTRAINT "reconciliations_broker_account_id_fkey" FOREIGN KEY ("broker_account_id") REFERENCES "broker_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "risk_limits" ADD CONSTRAINT "risk_limits_portfolio_id_fkey" FOREIGN KEY ("portfolio_id") REFERENCES "portfolios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "risk_limits" ADD CONSTRAINT "risk_limits_changed_by_id_fkey" FOREIGN KEY ("changed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "risk_events" ADD CONSTRAINT "risk_events_portfolio_id_fkey" FOREIGN KEY ("portfolio_id") REFERENCES "portfolios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "risk_events" ADD CONSTRAINT "risk_events_signal_id_fkey" FOREIGN KEY ("signal_id") REFERENCES "signals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "portfolio_snapshots" ADD CONSTRAINT "portfolio_snapshots_portfolio_id_fkey" FOREIGN KEY ("portfolio_id") REFERENCES "portfolios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "performance_metrics" ADD CONSTRAINT "performance_metrics_portfolio_id_fkey" FOREIGN KEY ("portfolio_id") REFERENCES "portfolios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fees" ADD CONSTRAINT "fees_portfolio_id_fkey" FOREIGN KEY ("portfolio_id") REFERENCES "portfolios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fees" ADD CONSTRAINT "fees_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_flows" ADD CONSTRAINT "cash_flows_portfolio_id_fkey" FOREIGN KEY ("portfolio_id") REFERENCES "portfolios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_analyses" ADD CONSTRAINT "ai_analyses_portfolio_id_fkey" FOREIGN KEY ("portfolio_id") REFERENCES "portfolios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_analyses" ADD CONSTRAINT "ai_analyses_signal_id_fkey" FOREIGN KEY ("signal_id") REFERENCES "signals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "backtests" ADD CONSTRAINT "backtests_portfolio_id_fkey" FOREIGN KEY ("portfolio_id") REFERENCES "portfolios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "backtests" ADD CONSTRAINT "backtests_strategy_id_fkey" FOREIGN KEY ("strategy_id") REFERENCES "strategies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "backtests" ADD CONSTRAINT "backtests_strategy_version_id_fkey" FOREIGN KEY ("strategy_version_id") REFERENCES "strategy_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "backtests" ADD CONSTRAINT "backtests_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "backtest_trades" ADD CONSTRAINT "backtest_trades_backtest_id_fkey" FOREIGN KEY ("backtest_id") REFERENCES "backtests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trade_journal_entries" ADD CONSTRAINT "trade_journal_entries_portfolio_id_fkey" FOREIGN KEY ("portfolio_id") REFERENCES "portfolios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trade_journal_entries" ADD CONSTRAINT "trade_journal_entries_position_id_fkey" FOREIGN KEY ("position_id") REFERENCES "positions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trade_journal_entries" ADD CONSTRAINT "trade_journal_entries_signal_id_fkey" FOREIGN KEY ("signal_id") REFERENCES "signals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trade_journal_entries" ADD CONSTRAINT "trade_journal_entries_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_portfolio_id_fkey" FOREIGN KEY ("portfolio_id") REFERENCES "portfolios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_portfolio_id_fkey" FOREIGN KEY ("portfolio_id") REFERENCES "portfolios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_consents" ADD CONSTRAINT "client_consents_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_consents" ADD CONSTRAINT "client_consents_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "compliance_documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_portfolio_id_fkey" FOREIGN KEY ("portfolio_id") REFERENCES "portfolios"("id") ON DELETE SET NULL ON UPDATE CASCADE;
