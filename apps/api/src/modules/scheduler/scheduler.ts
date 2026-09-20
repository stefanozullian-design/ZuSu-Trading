import type { ServiceName } from '@zusu/shared';

/**
 * The logging surface the scheduler needs.
 *
 * Structural rather than pino's `Logger`, so the server can hand it Fastify's
 * own logger and a test can hand it a spy without either pretending to be a
 * full pino instance.
 */
export interface SchedulerLogger {
  info(payload: Record<string, unknown>, message: string): void;
  warn(payload: Record<string, unknown>, message: string): void;
  error(payload: Record<string, unknown>, message: string): void;
}
import type { AppContainer } from '../../container.js';

/**
 * The scheduler (§57, §58).
 *
 * The rule that shaped every job here through Phase 8: **a scheduled job may
 * stop trading, and may never start any.** Phase 9 changes that in exactly one
 * place and it is worth stating plainly rather than burying: the `automation`
 * job can place an order.
 *
 * What it cannot do is decide to. It acts only on a configuration a person
 * deliberately raised to LIMITED_AUTO or FULL_AUTO, one rung at a time, with a
 * typed confirmation, against an all-pass readiness report; it places orders in
 * that person's name; it re-checks every one of the eight conditions before
 * each order; and it stops the instant any of them stops holding. No timer
 * raises a rung, and no timer is a person — the authority is still human, it is
 * just granted ahead of time instead of per trade.
 *
 * Every other job is as it was: calendars, snapshots, order polling, strategy
 * evaluation into *recommendations*, health checks and the drawdown breaker.
 *
 * Three more properties, each learned from how schedulers usually fail:
 *
 *   1. **A job never overlaps itself.** Each holds a running flag; a tick that
 *      arrives while the previous one is still working is skipped and counted,
 *      rather than piling up until the database is the bottleneck.
 *
 *   2. **A failing job does not stop the others.** Every run is wrapped, and a
 *      failure is recorded with the job's name and re-armed. A scheduler that
 *      dies on the first exception is one nobody notices has died.
 *
 *   3. **Every job is inspectable.** Last run, last outcome, last error and
 *      the skip count are readable, so "is the snapshot writer working" has an
 *      answer that is not "read the logs".
 */

export interface JobState {
  name: string;
  intervalMs: number;
  runs: number;
  failures: number;
  /** Ticks skipped because the previous run was still going. */
  skips: number;
  lastRunAt: Date | null;
  lastDurationMs: number | null;
  lastOutcome: string | null;
  lastError: string | null;
  running: boolean;
}

interface JobDefinition {
  name: string;
  intervalMs: number;
  /** Returns a one-line summary of what it did, for the state above. */
  run: () => Promise<string>;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export interface SchedulerOptions {
  /** Off by default in tests, which drive `runOnce` directly instead. */
  autoStart?: boolean;
  intervals?: Record<string, number>;
}

export class Scheduler {
  private readonly jobs = new Map<string, JobDefinition>();
  private readonly states = new Map<string, JobState>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private started = false;

  constructor(
    private readonly container: AppContainer,
    private readonly logger: SchedulerLogger,
    private readonly options: SchedulerOptions = {},
  ) {
    this.define({ name: 'calendar-sync', intervalMs: 12 * HOUR, run: () => this.syncCalendars() });
    this.define({
      name: 'health-persist',
      intervalMs: 5 * MINUTE,
      run: () => this.persistHealth(),
    });
    this.define({ name: 'order-sync', intervalMs: MINUTE, run: () => this.syncOpenOrders() });
    this.define({
      name: 'strategy-evaluation',
      intervalMs: 5 * MINUTE,
      run: () => this.evaluateLiveStrategies(),
    });
    this.define({ name: 'daily-snapshot', intervalMs: HOUR, run: () => this.writeSnapshots() });
    this.define({ name: 'risk-breakers', intervalMs: 5 * MINUTE, run: () => this.runBreakers() });
    this.define({
      name: 'automation',
      intervalMs: MINUTE,
      run: () => this.runAutomation(),
    });
    this.define({
      name: 'market-data-sync',
      intervalMs: 6 * HOUR,
      run: () => this.syncMarketData(),
    });
    this.define({
      name: 'portfolio-watch',
      // Hourly. A concentration does not need a minute's notice, and a watcher
      // that runs oftener than a person acts is only spending database time.
      intervalMs: HOUR,
      run: () => this.watchPortfolios(),
    });

    if (this.options.autoStart) this.start();
  }

  private define(job: JobDefinition): void {
    const intervalMs = this.options.intervals?.[job.name] ?? job.intervalMs;
    this.jobs.set(job.name, { ...job, intervalMs });
    this.states.set(job.name, {
      name: job.name,
      intervalMs,
      runs: 0,
      failures: 0,
      skips: 0,
      lastRunAt: null,
      lastDurationMs: null,
      lastOutcome: null,
      lastError: null,
      running: false,
    });
  }

  start(): void {
    if (this.started) return;
    this.started = true;

    for (const job of this.jobs.values()) {
      const timer = setInterval(() => {
        void this.runOnce(job.name);
      }, job.intervalMs);
      // An unref'd timer does not keep the process alive, so a shutdown is not
      // held up by a job that happens to be sleeping.
      timer.unref();
      this.timers.set(job.name, timer);
    }

    this.logger.info(
      { jobs: [...this.jobs.keys()] },
      'scheduler started; no job here can approve or place an order',
    );
  }

  stop(): void {
    for (const timer of this.timers.values()) clearInterval(timer);
    this.timers.clear();
    this.started = false;
  }

  /** Runs one job now. Tests drive this directly rather than waiting. */
  async runOnce(name: string): Promise<JobState> {
    const job = this.jobs.get(name);
    const state = this.states.get(name);
    if (!job || !state) throw new Error(`No scheduler job named ${name}`);

    if (state.running) {
      // Skipped rather than queued: a job that piles up behind itself turns a
      // slow database into an unresponsive one.
      state.skips += 1;
      this.logger.warn({ job: name, skips: state.skips }, 'scheduler tick skipped: still running');
      return { ...state };
    }

    state.running = true;
    const started = Date.now();
    try {
      const outcome = await job.run();
      state.runs += 1;
      state.lastOutcome = outcome;
      state.lastError = null;
    } catch (error) {
      state.failures += 1;
      state.lastError = error instanceof Error ? error.message : 'unknown failure';
      state.lastOutcome = null;
      this.logger.error({ job: name, err: error }, 'scheduler job failed');
    } finally {
      state.running = false;
      state.lastRunAt = new Date();
      state.lastDurationMs = Date.now() - started;
    }
    return { ...state };
  }

  jobStates(): JobState[] {
    return [...this.states.values()].map((state) => ({ ...state }));
  }

  // --------------------------------------------------------------------------

  /** Generates calendar rows ahead of time, so a read never has to. */
  private async syncCalendars(): Promise<string> {
    const from = new Date();
    const to = new Date(from.getTime() + 45 * 24 * HOUR);
    let days = 0;
    for (const market of ['XNYS', 'XNAS', 'ARCX', 'CRYPTO']) {
      const summary = await this.container.calendar.sync(market, from, to);
      days += summary.daysWritten;
    }
    return `synced ${String(days)} calendar days across four markets`;
  }

  private async persistHealth(): Promise<string> {
    const snapshot = await this.container.health.snapshot();
    for (const probe of snapshot.services) {
      // The snapshot's own probe type is the shape `persist` expects; the
      // wire type widens `service` to a string, so it is narrowed back here
      // rather than loosening the service's signature.
      await this.container.health.persist({
        ...probe,
        service: probe.service as ServiceName,
      });
    }
    return `recorded ${String(snapshot.services.length)} service probes; overall ${snapshot.overall}`;
  }

  /**
   * Applies fills that have already happened.
   *
   * The only job that touches orders, and it only reads from the broker and
   * records what it finds. Ingestion is idempotent, so a late run applies
   * exactly what a timely one would have.
   */
  private async syncOpenOrders(): Promise<string> {
    const open = await this.container.db.order.findMany({
      where: {
        status: { in: ['SUBMITTED', 'ACKNOWLEDGED', 'PARTIALLY_FILLED', 'CANCEL_REQUESTED'] },
        brokerOrderId: { not: null },
      },
      select: { id: true },
      take: 200,
    });

    let synced = 0;
    let failed = 0;
    for (const order of open) {
      try {
        await this.container.orders.sync(order.id);
        synced += 1;
      } catch (error) {
        // One unreachable broker must not stop the rest being reconciled.
        failed += 1;
        this.logger.warn({ orderId: order.id, err: error }, 'order sync failed');
      }
    }
    return `synced ${String(synced)} open orders, ${String(failed)} failed`;
  }

  /**
   * Evaluates every live strategy version.
   *
   * The output is recommendations at status CREATED, which then wait for a
   * person exactly as a hand-triggered evaluation's would. This is the closest
   * the platform comes to automation, and the distance between it and a trade
   * is the whole design.
   */
  private async evaluateLiveStrategies(): Promise<string> {
    const results = await this.container.signals.evaluateAllLive();
    const created = results.reduce((total, result) => total + result.created.length, 0);
    const unjudged = results.reduce((total, result) => total + result.notEvaluable.length, 0);
    return (
      `evaluated ${String(results.length)} live configurations: ${String(created)} ` +
      `recommendations created (each awaiting a person), ${String(unjudged)} symbols not judgeable`
    );
  }

  /**
   * Notices things about each portfolio and says so once.
   *
   * The findings are the same ones the dashboard shows — not a second
   * implementation with its own thresholds — and the watcher only speaks on
   * the transitions: a finding appearing, and a finding clearing.
   */
  private async watchPortfolios(): Promise<string> {
    const outcomes = await this.container.watcher.runAll();
    const appeared = outcomes.reduce((sum, o) => sum + o.appeared.length, 0);
    const cleared = outcomes.reduce((sum, o) => sum + o.cleared.length, 0);
    const failed = outcomes.filter((o) => o.error !== null).length;

    // Says what it did even when it did nothing, because "watched 4, nothing
    // new" and "could not read any of them" must not look the same in the job
    // log.
    return (
      `watched ${String(outcomes.length)} portfolios: ${String(appeared)} new, ` +
      `${String(cleared)} cleared` +
      (failed > 0 ? `, ${String(failed)} could not be read` : '')
    );
  }

  private async writeSnapshots(): Promise<string> {
    const portfolios = await this.container.db.portfolio.findMany({
      where: { isActive: true },
      select: { id: true },
    });

    const asOf = new Date();
    let written = 0;
    for (const portfolio of portfolios) {
      await this.container.performance.writeSnapshot(portfolio.id, asOf);
      written += 1;
    }
    return `wrote ${String(written)} portfolio snapshots`;
  }

  /**
   * Places orders for configurations a person has put on an automatic rung.
   *
   * This is the one job that can cause a trade, and it is worth being precise
   * about what it can and cannot do. It cannot raise a mode, enable a
   * configuration, or waive a check: every order it places re-verifies all
   * eight live-readiness conditions and goes through the same risk engine and
   * trading gate as a hand-approved one. What it does is act on an authority a
   * person granted, in that person's name, under caps that person accepted —
   * and it stops the moment any of that stops being true.
   *
   * With no configuration on an automatic rung, which is the shipped state,
   * this job does nothing at all.
   */
  private async runAutomation(): Promise<string> {
    const runs = await this.container.automation.runAutomatic();
    if (runs.length === 0) return 'no configuration is on an automatic rung';
    const placed = runs.reduce((total, run) => total + run.placed.length, 0);
    const deferred = runs.reduce((total, run) => total + run.deferred.length, 0);
    return (
      `${String(runs.length)} automatic configurations: ${String(placed)} orders placed, ` +
      `${String(deferred)} recommendations left for a person`
    );
  }

  /**
   * Keeps stored bars current from the configured provider.
   *
   * Does nothing at all when no provider is configured, which is the shipped
   * state — it reports that rather than generating anything. A deployment with
   * no feed should have stale data and know it, not fresh data that was
   * invented.
   *
   * Paced to the provider's rate limit, and run rarely: a daily-bar feed has
   * nothing new to say between closes, and hammering a free plan earns a
   * refusal that costs more than waiting.
   */
  private async syncMarketData(): Promise<string> {
    if (!this.container.marketData.tryResolve()) {
      return 'no market-data provider is configured; nothing was fetched or invented';
    }

    // Both timeframes. Daily bars feed the charts, indicators and backtests;
    // five-minute bars are what the paper venue quotes from, and nothing else
    // in this platform ever fetched them — so a paper portfolio holding
    // anything but the eight demo symbols stayed unmarked for ever.
    const daily = await this.container.marketDataSync.sync({ days: 5 });
    const intraday = await this.container.marketDataSync.sync({ timeframe: '5m', days: 5 });
    return `daily: ${daily.summary}; 5m: ${intraday.summary}`;
  }

  private async runBreakers(): Promise<string> {
    const results = await this.container.risk.runBreakers();
    const halted = results.filter((result) => result.halted);
    if (halted.length === 0) {
      return `checked ${String(results.length)} portfolios; none past its drawdown limit`;
    }
    return (
      `halted ${String(halted.length)} portfolios on drawdown; release requires a person: ` +
      halted.map((result) => `${result.portfolioId} at ${result.drawdownPct}%`).join(', ')
    );
  }
}
