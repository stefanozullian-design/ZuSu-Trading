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
import { MarketDataProviderRegistry } from './modules/market-data/provider-registry.js';
import { MarketDataQualityService } from './modules/market-data/quality.service.js';
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
  dataQuality: MarketDataQualityService;
  killSwitch: KillSwitchService;
  gate: TradingGate;
  ws: WebSocketGateway;
}

export function buildContainer(options: { db?: PrismaClient; logger?: Logger } = {}): AppContainer {
  const db = options.db ?? prisma();
  const logger = options.logger ?? createLogger();

  const audit = new AuditService(db);
  const access = new AccessControl(db, audit);
  const auth = new AuthService(db, audit);
  const brokers = new BrokerRegistry({ seed: config().DEMO_SEED });
  const ws = new WebSocketGateway(logger);
  const marketData = new MarketDataProviderRegistry();
  const health = new HealthService(db, ws, marketData);
  const dataQuality = new MarketDataQualityService(db);
  const calendar = new MarketCalendarService(db);
  const clients = new ClientService(db, access, audit);
  const portfolios = new PortfolioService(db, access, audit, brokers);
  const killSwitch = new KillSwitchService(db, access, audit, brokers, ws);
  const gate = new TradingGate(db, brokers, health, dataQuality, calendar);

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
    dataQuality,
    killSwitch,
    gate,
    ws,
  };
}
