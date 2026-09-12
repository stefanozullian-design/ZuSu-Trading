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

/** The subset of a scheduler job's state that health cares about. */
export interface SchedulerJobState {
  name: string;
  lastRunAt: Date | null;
  lastError: string | null;
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

  /**
   * The last three are functions rather than services so this stays free of
   * import cycles: health is read by the scheduler, which is built from the
   * container that builds health.
   */
  constructor(
    private readonly db: PrismaClient,
    private readonly ws?: WebSocketStatusProvider,
    private readonly marketData?: MarketDataProviderRegistry,
    private readonly analysisConfigured?: () => boolean,
    private schedulerStates?: () => SchedulerJobState[],
    private readonly brokerSupportedFor?: (environment: TradingEnvironment) => boolean,
  ) {}

  /** Attached after construction, because the scheduler is built later. */
  attachScheduler(states: () => SchedulerJobState[]): void {
    this.schedulerStates = states;
  }

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
    services.push(this.checkAnalysis());
    services.push(this.checkScheduler());
    services.push(await this.checkReconciliation());
    services.push(
      this.probe(
        ServiceName.NOTIFICATIONS,
        ServiceStatus.HEALTHY,
        null,
        'in-app notifications only; push, email and SMS have no transport and are refused',
      ),
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
      // True when an order could actually be placed in this environment: a
      // broker adapter exists for it and no dependency it needs is down. It
      // says nothing about whether a person should — the approval gate is
      // still a person's, and a halted portfolio still refuses.
      tradingEnabled:
        overall !== ServiceStatus.DOWN && this.brokerSupported(cfg.DEFAULT_ENVIRONMENT),
      services,
      checkedAt: new Date().toISOString(),
    };
    this.lastSnapshot = snapshot;
    return snapshot;
  }

  /**
   * Whether the analysis provider can be called at all.
   *
   * Unconfigured is DISABLED rather than DOWN: a platform with no API key is
   * in a normal state, not a broken one, and colouring it red would train
   * people to ignore the colour.
   */
  private checkAnalysis(): ServiceProbe {
    const configured = this.analysisConfigured?.() ?? false;
    return configured
      ? this.probe(ServiceName.CLAUDE, ServiceStatus.HEALTHY, null, 'provider configured')
      : this.probe(
          ServiceName.CLAUDE,
          ServiceStatus.DISABLED,
          null,
          'no ANTHROPIC_API_KEY, so no analysis can run; refusals are recorded',
        );
  }

  /**
   * Whether the scheduler's jobs are running and succeeding.
   *
   * A job that has failed more often than it has succeeded is DEGRADED rather
   * than healthy, because "the scheduler is up" and "the snapshots are being
   * written" are different questions.
   */
  /**
   * Reconciliation's health is the age and verdict of the last run.
   *
   * "Never run" is DISABLED rather than HEALTHY, for the same reason the
   * readiness gate calls it UNVERIFIABLE: a reconciler nobody has run has not
   * agreed with anything.
   */
  private async checkReconciliation(): Promise<ServiceProbe> {
    const latest = await this.db.reconciliation.findFirst({ orderBy: { startedAt: 'desc' } });
    if (!latest) {
      return this.probe(
        ServiceName.RECONCILIATION,
        ServiceStatus.DISABLED,
        null,
        'built, but never run — run it from the Risk page',
      );
    }

    const ageHours = (Date.now() - latest.startedAt.getTime()) / 3_600_000;
    if (!latest.succeeded) {
      return this.probe(
        ServiceName.RECONCILIATION,
        ServiceStatus.DEGRADED,
        null,
        latest.detail ?? 'the last run found differences; nothing was corrected automatically',
      );
    }
    return this.probe(
      ServiceName.RECONCILIATION,
      ServiceStatus.HEALTHY,
      null,
      `both records agreed ${ageHours.toFixed(1)}h ago`,
    );
  }

  private checkScheduler(): ServiceProbe {
    const states = this.schedulerStates?.() ?? null;
    if (!states || states.length === 0) {
      return this.probe(
        ServiceName.SCHEDULER,
        ServiceStatus.DISABLED,
        null,
        'no scheduler is attached to this process',
      );
    }

    const failing = states.filter((state) => state.lastError !== null);
    const neverRun = states.filter((state) => state.lastRunAt === null);
    if (failing.length > 0) {
      return this.probe(
        ServiceName.SCHEDULER,
        ServiceStatus.DEGRADED,
        null,
        `${String(failing.length)} of ${String(states.length)} jobs failed on their last run: ` +
          failing.map((state) => state.name).join(', '),
      );
    }
    return this.probe(
      ServiceName.SCHEDULER,
      ServiceStatus.HEALTHY,
      null,
      `${String(states.length - neverRun.length)} of ${String(states.length)} jobs have run`,
    );
  }

  private brokerSupported(environment: TradingEnvironment): boolean {
    return this.brokerSupportedFor?.(environment) ?? false;
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
    if (environment === TradingEnvironment.PAPER) {
      // The paper venue prices from stored bars rather than a network, so
      // "healthy" here means the platform has prices to match against. A
      // simulated venue reporting a network latency it never incurred would
      // be a comforting number about nothing.
      return this.probe(
        ServiceName.BROKER,
        ServiceStatus.HEALTHY,
        null,
        'paper venue, priced from stored market bars',
      );
    }
    if (environment !== TradingEnvironment.DEMO) {
      return this.probe(
        ServiceName.BROKER,
        ServiceStatus.DISABLED,
        null,
        config().ALLOW_LIVE_TRADING
          ? 'live adapter present; per-account and broker-side consent still decide'
          : 'live adapter present but ALLOW_LIVE_TRADING is false on this deployment',
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
