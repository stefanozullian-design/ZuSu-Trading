import type { PrismaClient } from '@prisma/client';
import { config } from './config/env.js';
import { createLogger, type Logger } from './lib/logger.js';
import { prisma } from './lib/prisma.js';
import { AuditService } from './modules/audit/audit.service.js';
import { AuthService } from './modules/auth/auth.service.js';
import { BrokerRegistry } from './modules/broker/broker-registry.js';
import { ClientService } from './modules/clients/client.service.js';
import { HealthService } from './modules/health/health.service.js';
import { MarketCalendarService } from './modules/market-data/calendar.service.js';
import { DemoFeed } from './modules/market-data/demo-feed.js';
import { IndicatorService } from './modules/market-data/indicator.service.js';
import { MarketDataProviderRegistry } from './modules/market-data/provider-registry.js';
import { MarketDataQualityService } from './modules/market-data/quality.service.js';
import { ScanService } from './modules/market-data/scan.service.js';
import { AnalysisService } from './modules/ai/analysis.service.js';
import { AnthropicProvider, UnconfiguredProvider } from './modules/ai/anthropic-provider.js';
import { BacktestService } from './modules/backtest/backtest.service.js';
import { JournalService } from './modules/journal/journal.service.js';
import { NotificationService } from './modules/notifications/notification.service.js';
import { ReconciliationService } from './modules/broker/reconciliation.service.js';
import { AutomationService } from './modules/automation/automation.service.js';
import { PositionImportService } from './modules/portfolios/position-import.service.js';
import { MarketDataSyncService } from './modules/market-data/market-data-sync.service.js';
import { InstrumentService } from './modules/market-data/instrument.service.js';
import { LiveReadinessService } from './modules/automation/live-readiness.js';
import { RiskEngine } from './modules/risk/risk-engine.js';
import { OrderService } from './modules/orders/order.service.js';
import { PerformanceService } from './modules/performance/performance.service.js';
import { SignalService } from './modules/strategies/signal.service.js';
import { StrategyService } from './modules/strategies/strategy.service.js';
import { WatchlistService } from './modules/market-data/watchlist.service.js';
import { PortfolioService } from './modules/portfolios/portfolio.service.js';
import { AccessControl } from './modules/rbac/access-control.js';
import { KillSwitchService } from './modules/risk/kill-switch.service.js';
import { TradingGate } from './modules/risk/trading-gate.js';
import { WebSocketGateway } from './modules/ws/gateway.js';

/**
 * Composition root. Services take their dependencies explicitly, so tests can
 * build the same graph against a test database without touching globals.
 */
export interface AppContainer {
  db: PrismaClient;
  logger: Logger;
  audit: AuditService;
  access: AccessControl;
  auth: AuthService;
  clients: ClientService;
  portfolios: PortfolioService;
  brokers: BrokerRegistry;
  health: HealthService;
  marketData: MarketDataProviderRegistry;
  calendar: MarketCalendarService;
  indicators: IndicatorService;
  demoFeed: DemoFeed;
  watchlists: WatchlistService;
  scans: ScanService;
  strategies: StrategyService;
  signals: SignalService;
  backtests: BacktestService;
  dataQuality: MarketDataQualityService;
  killSwitch: KillSwitchService;
  gate: TradingGate;
  orders: OrderService;
  performance: PerformanceService;
  journal: JournalService;
  analysis: AnalysisService;
  notifications: NotificationService;
  risk: RiskEngine;
  reconciliation: ReconciliationService;
  marketDataSync: MarketDataSyncService;
  instruments: InstrumentService;
  positionImport: PositionImportService;
  readiness: LiveReadinessService;
  automation: AutomationService;
  ws: WebSocketGateway;
}

export function buildContainer(options: { db?: PrismaClient; logger?: Logger } = {}): AppContainer {
  const db = options.db ?? prisma();
  const logger = options.logger ?? createLogger();

  const audit = new AuditService(db);
  const access = new AccessControl(db, audit);
  const auth = new AuthService(db, audit);
  const brokers = new BrokerRegistry({ seed: config().DEMO_SEED, db });
  const ws = new WebSocketGateway(logger);
  const marketData = new MarketDataProviderRegistry();
  const analysisKeyPresent = Boolean(config().ANTHROPIC_API_KEY);
  const health = new HealthService(
    db,
    ws,
    marketData,
    () => analysisKeyPresent,
    undefined,
    (environment) => brokers.isSupported(environment),
  );
  const dataQuality = new MarketDataQualityService(db);
  const calendar = new MarketCalendarService(db);
  const indicators = new IndicatorService(db);
  const demoFeed = new DemoFeed(db, dataQuality, calendar, { seed: config().DEMO_SEED });
  const watchlists = new WatchlistService(db);
  const scans = new ScanService(db, indicators, watchlists);
  const strategies = new StrategyService(db);
  const risk = new RiskEngine(db);
  const reconciliation = new ReconciliationService(db, brokers);
  const notifications = new NotificationService(db, access);
  const signals = new SignalService(
    db,
    strategies,
    indicators,
    watchlists,
    calendar,
    notifications,
  );
  const backtests = new BacktestService(db, strategies, indicators, watchlists);
  const clients = new ClientService(db, access, audit);
  const portfolios = new PortfolioService(db, access, audit, brokers);
  const killSwitch = new KillSwitchService(db, access, audit, brokers, ws);
  const gate = new TradingGate(db, brokers, health, dataQuality, calendar);
  const orders = new OrderService(db, access, audit, brokers, gate, risk, notifications);
  const performance = new PerformanceService(db, access, audit);
  const journal = new JournalService(db, access);
  // No key means a provider that refuses, not one that invents an answer: a
  // fabricated analysis is worse than none, because a reader cannot tell.
  const analysisKey = config().ANTHROPIC_API_KEY;
  const marketDataSync = new MarketDataSyncService(db, marketData, dataQuality, calendar);
  const instruments = new InstrumentService(db, access, audit, marketData, marketDataSync);
  const positionImport = new PositionImportService(db, access, audit);
  const readiness = new LiveReadinessService(db, brokers);
  const automation = new AutomationService(db, access, audit, readiness, orders);
  const analysis = new AnalysisService(
    db,
    analysisKey ? new AnthropicProvider({ apiKey: analysisKey }) : new UnconfiguredProvider(),
    indicators,
  );

  return {
    db,
    logger,
    audit,
    access,
    auth,
    clients,
    portfolios,
    brokers,
    health,
    marketData,
    calendar,
    indicators,
    demoFeed,
    watchlists,
    scans,
    strategies,
    signals,
    backtests,
    dataQuality,
    killSwitch,
    gate,
    orders,
    performance,
    journal,
    analysis,
    notifications,
    risk,
    reconciliation,
    marketDataSync,
    instruments,
    positionImport,
    readiness,
    automation,
    ws,
  };
}
