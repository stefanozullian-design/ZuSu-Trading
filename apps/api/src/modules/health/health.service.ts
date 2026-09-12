import type { PrismaClient } from '@prisma/client';
import { ServiceName, ServiceStatus, TradingEnvironment, type SystemHealth } from '@zusu/shared';
import { config } from '../../config/env.js';
import { CircuitBreaker } from '../../lib/circuit-breaker.js';
import { pingRedis } from '../../lib/redis.js';
import { DemoBroker } from '../broker/demo-broker.js';
import type { MarketDataProviderRegistry } from '../market-data/provider-registry.js';

export interface ServiceProbe {
  service: ServiceName;
  status: ServiceStatus;
  lastHeartbeatAt: string | null;
  latencyMs: number | null;
  detail: string | null;
}

export interface WebSocketStatusProvider {
  isRunning(): boolean;
  connectionCount(): number;
}

/**
 * Live health of every dependency (§46).
 *
 * Services that this phase does not implement report DISABLED with the phase
 * that brings them online, rather than a green light for something that is not
 * running.
 */
export class HealthService {
  private readonly breakers = new Map<ServiceName, CircuitBreaker>();
  private readonly probeBroker = new DemoBroker({ accountId: 'DEMO-HEALTH' });
  private lastSnapshot: SystemHealth | null = null;

  constructor(
    private readonly db: PrismaClient,
    private readonly ws?: WebSocketStatusProvider,
    private readonly marketData?: MarketDataProviderRegistry,
  ) {}

  private breaker(service: ServiceName): CircuitBreaker {
    let breaker = this.breakers.get(service);
    if (!breaker) {
      breaker = new CircuitBreaker({ name: service, failureThreshold: 3, resetTimeoutMs: 15_000 });
      this.breakers.set(service, breaker);
    }
    return breaker;
  }

  async snapshot(): Promise<SystemHealth> {
    const cfg = config();
    const services: ServiceProbe[] = [];

    services.push(await this.checkDatabase());
    services.push(await this.checkRedis());
    services.push(await this.checkBroker(cfg.DEFAULT_ENVIRONMENT));
    services.push(await this.checkMarketData(cfg.DEFAULT_ENVIRONMENT));
    services.push(this.checkWebSocket());
    services.push(this.notYetImplemented(ServiceName.CLAUDE, 'AI analysis arrives in Phase 6'));
    services.push(
      this.notYetImplemented(ServiceName.SCHEDULER, 'Scan scheduler arrives in Phase 7'),
    );
    services.push(
      this.notYetImplemented(
        ServiceName.RECONCILIATION,
        'Broker reconciliation arrives in Phase 8',
      ),
    );
    services.push(
      this.notYetImplemented(ServiceName.NOTIFICATIONS, 'Notification delivery arrives in Phase 6'),
    );

    const enabled = services.filter((s) => s.status !== ServiceStatus.DISABLED);
    const overall = enabled.some((s) => s.status === ServiceStatus.DOWN)
      ? ServiceStatus.DOWN
      : enabled.some((s) => s.status === ServiceStatus.DEGRADED)
        ? ServiceStatus.DEGRADED
        : ServiceStatus.HEALTHY;

    const snapshot: SystemHealth = {
      environment: cfg.DEFAULT_ENVIRONMENT,
      overall,
      // Phase 1 exposes no order-submission path at all, so nothing can trade
      // yet regardless of dependency health. Reported honestly rather than green.
      tradingEnabled: false,
      services,
      checkedAt: new Date().toISOString(),
    };
    this.lastSnapshot = snapshot;
    return snapshot;
  }

  lastKnown(): SystemHealth | null {
    return this.lastSnapshot;
  }

  /** Persists a probe so history and failure streaks survive a restart. */
  async persist(probe: ServiceProbe): Promise<void> {
    const previous = await this.db.systemHealthCheck.findFirst({
      where: { service: probe.service },
      orderBy: { checkedAt: 'desc' },
      select: { failureStreak: true, status: true },
    });
    const failed = probe.status === ServiceStatus.DOWN || probe.status === ServiceStatus.DEGRADED;
    await this.db.systemHealthCheck.create({
      data: {
        service: probe.service,
        status: probe.status,
        latencyMs: probe.latencyMs,
        detail: probe.detail,
        failureStreak: failed ? (previous?.failureStreak ?? 0) + 1 : 0,
      },
    });
  }

  private async checkDatabase(): Promise<ServiceProbe> {
    const started = Date.now();
    try {
      await this.breaker(ServiceName.DATABASE).execute(async () => {
        await this.db.$queryRaw`SELECT 1`;
      });
      return this.probe(ServiceName.DATABASE, ServiceStatus.HEALTHY, Date.now() - started, null);
    } catch (err) {
      return this.probe(ServiceName.DATABASE, ServiceStatus.DOWN, null, message(err));
    }
  }

  private async checkRedis(): Promise<ServiceProbe> {
    if (!config().REDIS_URL) {
      return this.probe(
        ServiceName.REDIS,
        ServiceStatus.DISABLED,
        null,
        'REDIS_URL is not configured; caching and background jobs are off',
      );
    }
    const result = await pingRedis();
    return result.ok
      ? this.probe(ServiceName.REDIS, ServiceStatus.HEALTHY, result.latencyMs, null)
      : this.probe(ServiceName.REDIS, ServiceStatus.DOWN, null, result.detail);
  }

  private async checkBroker(environment: TradingEnvironment): Promise<ServiceProbe> {
    if (environment !== TradingEnvironment.DEMO) {
      return this.probe(
        ServiceName.BROKER,
        ServiceStatus.DISABLED,
        null,
        environment === TradingEnvironment.PAPER
          ? 'Paper broker arrives in Phase 5'
          : 'Live broker adapter arrives in Phase 8',
      );
    }
    const started = Date.now();
    try {
      const health = await this.breaker(ServiceName.BROKER).execute(() =>
        this.probeBroker.healthCheck(),
      );
      return this.probe(
        ServiceName.BROKER,
        health.ok ? ServiceStatus.HEALTHY : ServiceStatus.DEGRADED,
        Date.now() - started,
        health.detail,
      );
    } catch (err) {
      return this.probe(ServiceName.BROKER, ServiceStatus.DOWN, null, message(err));
    }
  }

  private async checkMarketData(environment: TradingEnvironment): Promise<ServiceProbe> {
    // A configured provider is probed live, whatever the environment: a DEMO
    // deployment with a real feed should still be told when that feed is down.
    const provider = this.marketData?.tryResolve() ?? null;
    if (provider) {
      const health = await provider.healthCheck();
      const detail = [provider.name, health.detail].filter(Boolean).join(': ');
      return this.probe(
        ServiceName.MARKET_DATA,
        health.ok ? ServiceStatus.HEALTHY : ServiceStatus.DOWN,
        health.latencyMs,
        health.rateLimitRemaining === null
          ? detail
          : `${detail} (${health.rateLimitRemaining} requests left)`,
      );
    }

    if (environment !== TradingEnvironment.DEMO) {
      return this.probe(
        ServiceName.MARKET_DATA,
        ServiceStatus.DISABLED,
        null,
        'No market-data provider is configured. Set MARKET_DATA_PROVIDER and its credentials.',
      );
    }
    const started = Date.now();
    try {
      const quote = await this.probeBroker.getQuote('SPY');
      const ageMs = Date.now() - quote.sourceTimestamp.getTime();
      // Guards against a frozen simulator clock exactly as a real feed would.
      const stale = ageMs > 60_000;
      return this.probe(
        ServiceName.MARKET_DATA,
        stale ? ServiceStatus.DEGRADED : ServiceStatus.HEALTHY,
        Date.now() - started,
        stale ? `last quote is ${Math.round(ageMs / 1000)}s old` : 'demo simulator',
      );
    } catch (err) {
      return this.probe(ServiceName.MARKET_DATA, ServiceStatus.DOWN, null, message(err));
    }
  }

  private checkWebSocket(): ServiceProbe {
    if (!this.ws) {
      return this.probe(ServiceName.WEBSOCKET, ServiceStatus.DOWN, null, 'gateway not registered');
    }
    return this.ws.isRunning()
      ? this.probe(
          ServiceName.WEBSOCKET,
          ServiceStatus.HEALTHY,
          null,
          `${this.ws.connectionCount()} connected`,
        )
      : this.probe(ServiceName.WEBSOCKET, ServiceStatus.DOWN, null, 'gateway is not running');
  }

  private notYetImplemented(service: ServiceName, detail: string): ServiceProbe {
    return this.probe(service, ServiceStatus.DISABLED, null, detail);
  }

  private probe(
    service: ServiceName,
    status: ServiceStatus,
    latencyMs: number | null,
    detail: string | null,
  ): ServiceProbe {
    return {
      service,
      status,
      latencyMs,
      detail,
      lastHeartbeatAt: status === ServiceStatus.HEALTHY ? new Date().toISOString() : null,
    };
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
