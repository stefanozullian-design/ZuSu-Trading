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

export type PortfolioObjective = 'DAY_TRADING' | 'GROWTH' | 'INCOME' | 'RETIREMENT';

/** A person whose money is under management. Shown as "owner" on screen. */
export interface Owner {
  id: string;
  name: string;
  externalRef: string | null;
  contactEmail: string | null;
  isActive: boolean;
  portfolioCount: number;
  createdAt: string;
}

export interface PortfolioSummary {
  id: string;
  name: string;
  environment: TradingEnvironment;
  clientId: string | null;
  clientName: string | null;
  /** Null on portfolios created before objectives existed. Never guessed. */
  objective: PortfolioObjective | null;
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

export interface MarketInstrument {
  symbol: string;
  name: string | null;
  assetClass: string;
  exchange: string | null;
  isTradable: boolean;
  barCount: number;
  lastClose: string | null;
  lastBarAt: string | null;
}

export interface InstrumentList {
  provider: string;
  isDelayed: boolean | null;
  instruments: MarketInstrument[];
}

export interface MarketCandle {
  openTime: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  vwap: string | null;
  provider: string;
}

export interface CandleSeries {
  symbol: string;
  timeframe: string;
  candles: MarketCandle[];
}

export interface IndicatorSnapshot {
  symbol: string;
  timeframe: string;
  asOf: string;
  close: string;
  barsAvailable: number;
  sma20: string | null;
  sma50: string | null;
  ema12: string | null;
  ema26: string | null;
  rsi14: string | null;
  macd: string | null;
  macdSignal: string | null;
  macdHistogram: string | null;
  bollingerUpper: string | null;
  bollingerMiddle: string | null;
  bollingerLower: string | null;
  atr14: string | null;
  vwap: string | null;
  stochasticK: string | null;
  stochasticD: string | null;
  obv: string;
}

export interface TradabilityVerdict {
  symbol: string;
  tradable: boolean;
  session: string;
  marketCode: string;
  reason: string | null;
}

export interface QualityEvent {
  symbol: string | null;
  issue: string;
  detail: string;
  detectedAt: string;
}

export interface QualityReport {
  ok: boolean;
  feedWide: QualityEvent[];
  bySymbol: QualityEvent[];
  recent: {
    symbol: string | null;
    issue: string;
    detail: string;
    blocking: boolean;
    detectedAt: string;
    resolvedAt: string | null;
  }[];
}

export interface CalendarView {
  marketCode: string;
  session: string;
  asOf: string;
  days: {
    date: string;
    isTradingDay: boolean;
    regularOpen: string | null;
    regularClose: string | null;
    isEarlyClose: boolean;
    holidayName: string | null;
  }[];
  openHalts: { symbol: string; reason: string; haltedAt: string }[];
}

export interface Watchlist {
  id: string;
  name: string;
  description: string | null;
  portfolioId: string | null;
  isSystem: boolean;
  symbols: string[];
  updatedAt: string;
}

export type ScanOperand = { constant: string } | { field: string };

export interface ScanCondition {
  field: string;
  operator: string;
  operand: ScanOperand;
  operandUpper?: ScanOperand;
}

export interface SavedScan {
  id: string;
  name: string;
  description: string | null;
  timeframe: string;
  conditions: ScanCondition[];
  summary: string[];
  watchlistId: string | null;
  lastRunAt: string | null;
  updatedAt: string;
}

export interface ScanRunResult {
  timeframe: string;
  ranAt: string;
  summary: string[];
  universe: string[];
  evaluated: number;
  matches: { symbol: string; asOf: string; values: Record<string, string> }[];
  notEvaluable: { symbol: string; reason: string; missingField: string | null }[];
}

export type RuleNode =
  | { type: 'all'; children: RuleNode[] }
  | { type: 'any'; children: RuleNode[] }
  | { type: 'not'; child: RuleNode }
  | ({ type: 'condition' } & ScanCondition);

export interface StrategyStopSetting {
  kind: 'PERCENT' | 'ATR';
  value: string;
}

export interface StrategyTargetSetting {
  kind: 'PERCENT' | 'ATR' | 'RISK_MULTIPLE';
  value: string;
}

export interface StrategyDefinition {
  timeframe: string;
  watchlistId: string | null;
  entry: { direction: 'LONG' | 'SHORT'; when: RuleNode };
  exit: { when: RuleNode } | null;
  stop: StrategyStopSetting | null;
  target: StrategyTargetSetting | null;
}

export interface StrategyRiskSettings {
  maxConcurrentPositions: number;
  maxNotionalPerTrade: string;
  minBars: number;
}

export interface StrategyVersion {
  id: string;
  strategyId: string;
  version: number;
  stage: string;
  changeDescription: string;
  /** Null when the API cannot read this version's rule language. */
  definition: StrategyDefinition | null;
  riskSettings: StrategyRiskSettings | null;
  executionMode: string;
  sessionScope: string;
  entrySummary: string | null;
  exitSummary: string | null;
  fieldsUsed: string[];
  frozen: boolean;
  authorId: string | null;
  approvedById: string | null;
  approvedAt: string | null;
  createdAt: string;
}

export interface Strategy {
  id: string;
  name: string;
  description: string | null;
  isArchived: boolean;
  versions: StrategyVersion[];
  liveVersion: StrategyVersion | null;
  latestVersion: StrategyVersion | null;
}

export interface StrategyEvaluation {
  strategyId: string;
  strategyVersionId: string;
  version: number;
  timeframe: string;
  correlationId: string;
  evaluatedAt: string;
  created: { id: string; signalKey: string; symbol: string; direction: string }[];
  duplicates: string[];
  rejected: string[];
  notEvaluable: { symbol: string; reason: string }[];
}

export interface SignalRow {
  id: string;
  signalKey: string;
  symbol: string;
  direction: string;
  status: string;
  referencePrice: string;
  suggestedStop: string | null;
  suggestedTarget: string | null;
  strategyName: string | null;
  strategyVersion: number | null;
  conditionSnapshot: Record<string, unknown>;
  createdAt: string;
}

export interface BacktestCaveats {
  ambiguousExits: number;
  gapThroughStop: number;
  unknownVerdicts: number;
  signalsNotTaken: number;
  openAtEnd: number;
  ratiosSuppressed: boolean;
  ratiosInflatedByLowExposure: boolean;
}

export interface BacktestMetrics {
  initialCapital: string;
  finalEquity: string;
  netProfit: string;
  grossProfit: string;
  feesPaid: string;
  slippagePaid: string;
  totalReturnPct: string;
  cagrPct: string | null;
  maxDrawdownPct: string;
  maxDrawdownAmount: string;
  maxDrawdownRecoveryBars: number | null;
  tradeCount: number;
  winCount: number;
  lossCount: number;
  scratchCount: number;
  winRatePct: string;
  avgWin: string;
  avgLoss: string;
  profitFactor: string | null;
  expectancy: string;
  avgRMultiple: string | null;
  payoffRatio: string | null;
  sharpe: string | null;
  sortino: string | null;
  exposurePct: string;
  avgBarsHeld: string;
  longestWinStreak: number;
  longestLossStreak: number;
  caveats: BacktestCaveats;
}

export interface WalkForwardFold {
  index: number;
  inSampleFrom: string;
  inSampleTo: string;
  outOfSampleFrom: string;
  outOfSampleTo: string;
  inSampleReturnPct: string;
  outOfSampleReturnPct: string;
  inSampleTrades: number;
  outOfSampleTrades: number;
  degradationPct: string | null;
}

export interface WalkForwardResult {
  folds: WalkForwardFold[];
  meanOutOfSampleReturnPct: string | null;
  profitableFolds: number;
  comparableFolds: number;
  verdict: string;
}

export interface MonteCarloResult {
  iterations: number;
  tradesResampled: number;
  equityPercentiles: { p5: string; p25: string; p50: string; p75: string; p95: string };
  drawdownPercentiles: { p50: string; p75: string; p95: string };
  probabilityOfLossPct: string;
  worstDrawdownPct: string;
  verdict: string;
}

export interface BacktestParameters {
  universe: string[];
  barsLoaded: number;
  windowUsed: { from: string; to: string } | null;
  costs: {
    commissionPerTrade: string;
    commissionPerShare: string;
    spreadFraction: string;
    slippageFraction: string;
  };
  assumptions: string[];
}

export interface BacktestTradeRow {
  symbol: string;
  direction: string;
  quantity: string;
  entryTime: string;
  entryPrice: string;
  exitTime: string | null;
  exitPrice: string | null;
  grossPnl: string | null;
  fees: string;
  slippage: string;
  netPnl: string | null;
  rMultiple: string | null;
  maeAmount: string | null;
  mfeAmount: string | null;
  exitReason: string | null;
}

export interface BacktestSummary {
  id: string;
  strategyId: string;
  strategyVersionId: string;
  strategyName: string;
  version: number;
  status: string;
  timeframe: string;
  startDate: string;
  endDate: string;
  initialCapital: string;
  parameters: BacktestParameters;
  metrics: BacktestMetrics | null;
  walkForward: WalkForwardResult | null;
  monteCarlo: MonteCarloResult | null;
  equityCurve: { at: string; equity: string }[];
  skips: { at: string; symbol: string; reason: string }[];
  errorMessage: string | null;
  createdAt: string;
  finishedAt: string | null;
  tradeCount: number;
}

export interface BacktestDetail extends BacktestSummary {
  trades: BacktestTradeRow[];
}

export interface OrderExecution {
  id: string;
  quantity: string;
  price: string;
  fees: string;
  executedAt: string;
}

export interface OrderRow {
  id: string;
  idempotencyKey: string;
  correlationId: string;
  portfolioId: string;
  signalId: string | null;
  symbol: string;
  side: string;
  orderType: string;
  timeInForce: string;
  status: string;
  environment: string;
  requestedQty: string;
  filledQty: string;
  limitPrice: string | null;
  stopPrice: string | null;
  averageFillPrice: string | null;
  expectedPrice: string | null;
  slippage: string | null;
  feesTotal: string;
  rejectionReason: string | null;
  brokerOrderId: string | null;
  submittedAt: string | null;
  filledAt: string | null;
  createdAt: string;
  executions: OrderExecution[];
}

export interface TaxLot {
  id: string;
  quantity: string;
  remainingQty: string;
  costBasis: string;
  openedAt: string;
  closedAt: string | null;
  realizedGain: string;
}

export interface PositionWithLots {
  id: string;
  symbol: string;
  status: string;
  quantity: string;
  averageEntryPrice: string;
  markPrice: string | null;
  realizedPnl: string;
  /** Null when nothing has priced the symbol — never rendered as zero. */
  unrealizedPnl: string | null;
  feesTotal: string;
  stopPrice: string | null;
  targetPrice: string | null;
  openedAt: string;
  closedAt: string | null;
  lots: TaxLot[];
}

export interface PortfolioSnapshotRow {
  asOf: string;
  cashBalance: string;
  positionsValue: string;
  equity: string;
  netCashFlow: string;
  realizedPnl: string;
  unrealizedPnl: string;
  feesTotal: string;
  openPositions: number;
}

export interface PerformanceReport {
  portfolioId: string;
  from: string;
  to: string;
  openingEquity: string;
  closingEquity: string;
  netDeposits: string;
  investmentGain: string;
  timeWeightedReturnPct: string | null;
  moneyWeightedReturnPct: string | null;
  realizedPnl: string;
  unrealizedPnl: string;
  feesPaid: string;
  maxDrawdownPct: string;
  snapshots: PortfolioSnapshotRow[];
  notes: string[];
}

export interface JournalEntry {
  id: string;
  portfolioId: string;
  positionId: string | null;
  signalId: string | null;
  symbol: string | null;
  entryThesis: string | null;
  technicalContext: Record<string, unknown> | null;
  aiReasoning: string | null;
  outcome: string | null;
  lessons: string | null;
  userNotes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AnalysisSpend {
  spentTodayUsd: string;
  callsLastHour: number;
  limits: { dailyUsd: string; callsPerHour: number; maxOutputTokensPerCall: number };
  providerConfigured: boolean;
  providerName: string;
}

export interface AnalysisRow {
  id: string;
  signalId: string | null;
  portfolioId: string | null;
  model: string;
  purpose: string;
  responseValid: boolean;
  validationError: string | null;
  action: string | null;
  confidence: string | null;
  riskLevel: string | null;
  regime: string | null;
  rationale: string | null;
  invalidation: string | null;
  missingContext: string[];
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: string | null;
  latencyMs: number | null;
  createdAt: string;
}

export interface NotificationRow {
  id: string;
  event: string;
  title: string;
  body: string;
  status: string;
  channel: string;
  portfolioId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  sentAt: string | null;
}

export interface RiskCheckRow {
  limitName: string;
  passed: boolean;
  actual: string | null;
  limit: string;
  message: string;
  severity: string;
}

export interface RiskSizing {
  quantity: string;
  riskAmount: string;
  riskPerShare: string | null;
  notional: string;
  boundBy: string;
  reason: string | null;
  volatilityFloorApplied: boolean;
}

export interface RiskAssessment {
  allowed: boolean;
  checks: RiskCheckRow[];
  breaches: Record<string, unknown>[];
  nearMisses: Record<string, unknown>[];
  sizing: RiskSizing | null;
}

export interface RiskEventRow {
  id: string;
  type: string;
  severity: string;
  message: string;
  limitName: string | null;
  limitValue: string | null;
  actualValue: string | null;
  createdAt: string;
}

/** A reconciliation run: what the broker says, what this platform says (§26). */
export interface ReconciliationDifference {
  kind:
    | 'CASH'
    | 'POSITION_QUANTITY'
    | 'POSITION_PRICE'
    | 'POSITION_MISSING_HERE'
    | 'POSITION_MISSING_AT_BROKER'
    | 'ORDER_PLACED_ELSEWHERE';
  symbol: string | null;
  ours: string | null;
  theirs: string | null;
  detail: string;
}

export interface ReconciliationRun {
  id: string;
  portfolioId: string;
  succeeded: boolean;
  cashMismatch: boolean;
  positionMismatch: boolean;
  orderMismatch: boolean;
  differences: ReconciliationDifference[];
  detail: string;
}

export type ExecutionModeName = 'OBSERVE' | 'MANUAL_APPROVAL' | 'LIMITED_AUTO' | 'FULL_AUTO';

export interface AutomationConfig {
  configId: string;
  strategyName: string;
  version: number;
  portfolioId: string;
  portfolioName: string;
  environment: string;
  isEnabled: boolean;
  mode: ExecutionModeName;
  promotedById: string | null;
}

/** The eight conditions for going live. UNVERIFIABLE is not a pass. */
export interface ReadinessReport {
  configId: string;
  portfolioId: string;
  currentMode: ExecutionModeName;
  nextMode: ExecutionModeName | null;
  ready: boolean;
  summary: string;
  checks: {
    key: string;
    label: string;
    state: 'PASS' | 'FAIL' | 'UNVERIFIABLE';
    detail: string;
  }[];
}
