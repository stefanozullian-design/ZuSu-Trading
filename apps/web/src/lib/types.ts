/** Response shapes mirrored from the API's zod schemas. */
export type TradingEnvironment = 'DEMO' | 'PAPER' | 'LIVE';
export type UserRole = 'ADMIN' | 'MANAGER' | 'CLIENT' | 'VIEWER';
export type TradingState = 'ACTIVE' | 'HALTED' | 'RECONCILIATION_ERROR';
export type ServiceStatus = 'HEALTHY' | 'DEGRADED' | 'DOWN' | 'DISABLED' | 'UNKNOWN';

export interface AuthenticatedUser {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
  mfaEnabled: boolean;
  permissions: string[];
  portfolioIds: string[];
}

export type LoginResponse =
  | { status: 'MFA_REQUIRED'; mfaToken: string }
  | { status: 'MFA_ENROLMENT_REQUIRED'; mfaToken: string }
  | {
      status: 'AUTHENTICATED';
      user: AuthenticatedUser;
      csrfToken: string;
      accessTokenExpiresAt: string;
    };

export interface EnvironmentInfo {
  environment: TradingEnvironment;
  label: string;
  indicator: string;
  tone: 'blue' | 'amber' | 'red';
  description: string;
  usesRealMoney: boolean;
  requiresExplicitConfirmation: boolean;
  liveTradingAllowed: boolean;
}

export interface PortfolioSummary {
  id: string;
  name: string;
  environment: TradingEnvironment;
  clientId: string | null;
  clientName: string | null;
  baseCurrency: string;
  executionMode: string;
  tradingState: TradingState;
  isActive: boolean;
  cashBalance: string;
  positionsValue: string | null;
  equity: string | null;
  initialCapital: string;
  dailyPnl: string | null;
  dailyPnlPct: string | null;
  openPositions: number;
  dailyRiskUsedPct: string | null;
  killSwitchEngaged: boolean;
}

export interface Position {
  id: string;
  portfolioId: string;
  symbol: string;
  assetClass: string;
  quantity: string;
  averageEntryPrice: string;
  markPrice: string | null;
  marketValue: string | null;
  unrealizedPnl: string | null;
  realizedPnl: string;
  openedAt: string;
}

export interface ServiceHealth {
  service: string;
  status: ServiceStatus;
  lastHeartbeatAt: string | null;
  latencyMs: number | null;
  detail: string | null;
}

export interface SystemHealth {
  environment: TradingEnvironment;
  overall: ServiceStatus;
  tradingEnabled: boolean;
  services: ServiceHealth[];
  checkedAt: string;
}

export interface GateBlocker {
  code: string;
  message: string;
  severity: 'BLOCKING' | 'WARNING';
}

export interface GateDecision {
  portfolioId: string;
  allowed: boolean;
  blockers: GateBlocker[];
  checkedAt: string;
}

export interface RiskLimits {
  portfolioId: string;
  version: number;
  maxDailyLoss: string;
  maxWeeklyLoss: string;
  maxPositionSize: string;
  maxPortfolioExposurePct: string;
  maxSectorExposurePct: string;
  maxSymbolExposurePct: string;
  maxOpenPositions: number;
  maxTradesPerDay: number;
  maxConsecutiveLosses: number;
  maxDrawdownPct: string;
}

export interface AuditEntry {
  seq: string;
  id: string;
  occurredAt: string;
  action: string;
  actorType: string;
  actorUserId: string | null;
  actorEmail: string | null;
  entityType: string | null;
  entityId: string | null;
  portfolioId: string | null;
  environment: string | null;
  correlationId: string | null;
  ip: string | null;
  hash: string;
}

export interface MfaEnrolment {
  secret: string;
  otpauthUrl: string;
  qrDataUrl: string;
}
