/**
 * Domain enums shared between the API and the web client.
 *
 * These values are mirrored 1:1 by the Prisma schema. Changing a member here is
 * a breaking database change and requires a migration.
 */

/** Isolated runtime environments. See ARCHITECTURE.md §"Environment separation". */
export const TradingEnvironment = {
  DEMO: 'DEMO',
  PAPER: 'PAPER',
  LIVE: 'LIVE',
} as const;
export type TradingEnvironment = (typeof TradingEnvironment)[keyof typeof TradingEnvironment];

export const TRADING_ENVIRONMENTS: TradingEnvironment[] = ['DEMO', 'PAPER', 'LIVE'];

/** Coarse-grained roles. Fine-grained checks live in `permissions.ts`. */
export const UserRole = {
  ADMIN: 'ADMIN',
  MANAGER: 'MANAGER',
  CLIENT: 'CLIENT',
  VIEWER: 'VIEWER',
} as const;
export type UserRole = (typeof UserRole)[keyof typeof UserRole];

/** Whether a portfolio's signals reach the broker automatically or need a human. */
export const ExecutionMode = {
  /** Signals are recorded only; nothing is ever sent to a broker. */
  OBSERVE: 'OBSERVE',
  /** Every order requires an explicit human approval before submission. */
  MANUAL_APPROVAL: 'MANUAL_APPROVAL',
  /** Orders are submitted automatically but capped by per-day/per-order limits. */
  LIMITED_AUTO: 'LIMITED_AUTO',
  /** Orders are submitted automatically within the risk engine's limits. */
  FULL_AUTO: 'FULL_AUTO',
} as const;
export type ExecutionMode = (typeof ExecutionMode)[keyof typeof ExecutionMode];

/** Portfolio-level trading state, driven by kill switches and health checks. */
export const TradingState = {
  ACTIVE: 'ACTIVE',
  /** New entries blocked, existing positions still monitored/manageable. */
  HALTED: 'HALTED',
  /** Broker/internal state disagree; everything blocked until resolved. */
  RECONCILIATION_ERROR: 'RECONCILIATION_ERROR',
} as const;
export type TradingState = (typeof TradingState)[keyof typeof TradingState];

export const OrderSide = { BUY: 'BUY', SELL: 'SELL' } as const;
export type OrderSide = (typeof OrderSide)[keyof typeof OrderSide];

export const OrderType = {
  MARKET: 'MARKET',
  LIMIT: 'LIMIT',
  STOP: 'STOP',
  STOP_LIMIT: 'STOP_LIMIT',
} as const;
export type OrderType = (typeof OrderType)[keyof typeof OrderType];

export const TimeInForce = { DAY: 'DAY', GTC: 'GTC', IOC: 'IOC', FOK: 'FOK' } as const;
export type TimeInForce = (typeof TimeInForce)[keyof typeof TimeInForce];

export const AssetClass = {
  EQUITY: 'EQUITY',
  OPTION: 'OPTION',
  CRYPTO: 'CRYPTO',
  ETF: 'ETF',
} as const;
export type AssetClass = (typeof AssetClass)[keyof typeof AssetClass];

/** Order lifecycle. A broker HTTP 200 only ever gets us to SUBMITTED. */
export const OrderStatus = {
  CREATED: 'CREATED',
  SUBMITTED: 'SUBMITTED',
  ACKNOWLEDGED: 'ACKNOWLEDGED',
  PARTIALLY_FILLED: 'PARTIALLY_FILLED',
  FILLED: 'FILLED',
  CANCEL_REQUESTED: 'CANCEL_REQUESTED',
  CANCELLED: 'CANCELLED',
  REJECTED: 'REJECTED',
  EXPIRED: 'EXPIRED',
  /** Broker state could not be determined — never assume success. */
  UNKNOWN: 'UNKNOWN',
} as const;
export type OrderStatus = (typeof OrderStatus)[keyof typeof OrderStatus];

/** Signal lifecycle. Consumed by the signal engine (Phase 3). */
export const SignalStatus = {
  CREATED: 'CREATED',
  ANALYZING: 'ANALYZING',
  RISK_CHECK: 'RISK_CHECK',
  PENDING_APPROVAL: 'PENDING_APPROVAL',
  APPROVED: 'APPROVED',
  ORDER_SUBMITTED: 'ORDER_SUBMITTED',
  PARTIALLY_FILLED: 'PARTIALLY_FILLED',
  FILLED: 'FILLED',
  POSITION_OPEN: 'POSITION_OPEN',
  EXIT_PENDING: 'EXIT_PENDING',
  CLOSED: 'CLOSED',
  REJECTED: 'REJECTED',
  EXPIRED: 'EXPIRED',
  SKIPPED: 'SKIPPED',
  CANCELLED: 'CANCELLED',
  FAILED: 'FAILED',
} as const;
export type SignalStatus = (typeof SignalStatus)[keyof typeof SignalStatus];

/** Mirrors `SignalDirection` in the Prisma schema. */
export const SignalDirection = {
  LONG: 'LONG',
  SHORT: 'SHORT',
} as const;
export type SignalDirection = (typeof SignalDirection)[keyof typeof SignalDirection];

export const StrategyStage = {
  DRAFT: 'DRAFT',
  BACKTEST: 'BACKTEST',
  PAPER: 'PAPER',
  REVIEW: 'REVIEW',
  APPROVED: 'APPROVED',
  LIVE: 'LIVE',
  RETIRED: 'RETIRED',
} as const;
export type StrategyStage = (typeof StrategyStage)[keyof typeof StrategyStage];

/**
 * Which sessions a strategy is allowed to act in.
 *
 * Mirrors `TradingSessionScope` in the Prisma schema, which had no counterpart
 * here — the two are meant to match member for member.
 */
export const TradingSessionScope = {
  REGULAR_ONLY: 'REGULAR_ONLY',
  INCLUDE_PRE_MARKET: 'INCLUDE_PRE_MARKET',
  INCLUDE_AFTER_HOURS: 'INCLUDE_AFTER_HOURS',
  ALL_AVAILABLE: 'ALL_AVAILABLE',
} as const;
export type TradingSessionScope = (typeof TradingSessionScope)[keyof typeof TradingSessionScope];

export const MarketSession = {
  CLOSED: 'CLOSED',
  PRE_MARKET: 'PRE_MARKET',
  REGULAR: 'REGULAR',
  AFTER_HOURS: 'AFTER_HOURS',
  HALTED: 'HALTED',
} as const;
export type MarketSession = (typeof MarketSession)[keyof typeof MarketSession];

export const MarketRegimeType = {
  TRENDING: 'TRENDING',
  RANGE_BOUND: 'RANGE_BOUND',
  HIGH_VOLATILITY: 'HIGH_VOLATILITY',
  LOW_VOLATILITY: 'LOW_VOLATILITY',
  BULLISH: 'BULLISH',
  BEARISH: 'BEARISH',
  NEUTRAL: 'NEUTRAL',
  RISK_ON: 'RISK_ON',
  RISK_OFF: 'RISK_OFF',
} as const;
export type MarketRegimeType = (typeof MarketRegimeType)[keyof typeof MarketRegimeType];

export const ServiceName = {
  MARKET_DATA: 'MARKET_DATA',
  BROKER: 'BROKER',
  CLAUDE: 'CLAUDE',
  DATABASE: 'DATABASE',
  REDIS: 'REDIS',
  SCHEDULER: 'SCHEDULER',
  WEBSOCKET: 'WEBSOCKET',
  RECONCILIATION: 'RECONCILIATION',
  NOTIFICATIONS: 'NOTIFICATIONS',
} as const;
export type ServiceName = (typeof ServiceName)[keyof typeof ServiceName];

export const ServiceStatus = {
  HEALTHY: 'HEALTHY',
  DEGRADED: 'DEGRADED',
  DOWN: 'DOWN',
  DISABLED: 'DISABLED',
  UNKNOWN: 'UNKNOWN',
} as const;
export type ServiceStatus = (typeof ServiceStatus)[keyof typeof ServiceStatus];

/** Every auditable action. Append-only; never renumber or reuse a value. */
export const AuditAction = {
  USER_CREATED: 'USER_CREATED',
  USER_MODIFIED: 'USER_MODIFIED',
  USER_DISABLED: 'USER_DISABLED',
  LOGIN: 'LOGIN',
  LOGIN_FAILED: 'LOGIN_FAILED',
  LOGOUT: 'LOGOUT',
  MFA_ENROLLED: 'MFA_ENROLLED',
  MFA_DISABLED: 'MFA_DISABLED',
  MFA_CHALLENGE_FAILED: 'MFA_CHALLENGE_FAILED',
  TOKEN_REFRESHED: 'TOKEN_REFRESHED',
  TOKEN_REUSE_DETECTED: 'TOKEN_REUSE_DETECTED',
  CLIENT_CREATED: 'CLIENT_CREATED',
  CLIENT_MODIFIED: 'CLIENT_MODIFIED',
  PORTFOLIO_CREATED: 'PORTFOLIO_CREATED',
  PORTFOLIO_MODIFIED: 'PORTFOLIO_MODIFIED',
  PORTFOLIO_ACCESS_GRANTED: 'PORTFOLIO_ACCESS_GRANTED',
  PORTFOLIO_ACCESS_REVOKED: 'PORTFOLIO_ACCESS_REVOKED',
  PORTFOLIO_ACCESS_DENIED: 'PORTFOLIO_ACCESS_DENIED',
  BROKER_ACCOUNT_CREATED: 'BROKER_ACCOUNT_CREATED',
  BROKER_ACCOUNT_MODIFIED: 'BROKER_ACCOUNT_MODIFIED',
  BROKER_CONNECTED: 'BROKER_CONNECTED',
  BROKER_DISCONNECTED: 'BROKER_DISCONNECTED',
  STRATEGY_CREATED: 'STRATEGY_CREATED',
  STRATEGY_MODIFIED: 'STRATEGY_MODIFIED',
  STRATEGY_VERSION_CREATED: 'STRATEGY_VERSION_CREATED',
  STRATEGY_ENABLED: 'STRATEGY_ENABLED',
  STRATEGY_DISABLED: 'STRATEGY_DISABLED',
  STRATEGY_PROMOTED: 'STRATEGY_PROMOTED',
  SIGNAL_CREATED: 'SIGNAL_CREATED',
  SIGNAL_APPROVED: 'SIGNAL_APPROVED',
  SIGNAL_REJECTED: 'SIGNAL_REJECTED',
  SIGNAL_EXPIRED: 'SIGNAL_EXPIRED',
  ORDER_SUBMITTED: 'ORDER_SUBMITTED',
  ORDER_FILLED: 'ORDER_FILLED',
  ORDER_CANCELLED: 'ORDER_CANCELLED',
  ORDER_REJECTED: 'ORDER_REJECTED',
  RISK_LIMIT_CHANGED: 'RISK_LIMIT_CHANGED',
  RISK_CHECK_FAILED: 'RISK_CHECK_FAILED',
  KILL_SWITCH_ACTIVATED: 'KILL_SWITCH_ACTIVATED',
  KILL_SWITCH_RELEASED: 'KILL_SWITCH_RELEASED',
  TRADING_HALTED: 'TRADING_HALTED',
  TRADING_RESUMED: 'TRADING_RESUMED',
  RECONCILIATION_STARTED: 'RECONCILIATION_STARTED',
  RECONCILIATION_MISMATCH: 'RECONCILIATION_MISMATCH',
  ENVIRONMENT_SWITCHED: 'ENVIRONMENT_SWITCHED',
  LIVE_MODE_CONFIRMED: 'LIVE_MODE_CONFIRMED',
  REPORT_GENERATED: 'REPORT_GENERATED',
} as const;
export type AuditAction = (typeof AuditAction)[keyof typeof AuditAction];
