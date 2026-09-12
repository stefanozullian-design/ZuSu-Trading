import type { Portfolio, PrismaClient } from '@prisma/client';
import { TradingEnvironment, assertSameEnvironment } from '@zusu/shared';
import { config } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';
import { DemoBroker } from './demo-broker.js';
import { PaperBroker } from './paper-broker.js';
import { RobinhoodBroker } from './robinhood/robinhood-broker.js';
import { UnconfiguredRobinhoodTransport, type RobinhoodTransport } from './robinhood/transport.js';
import { StoredBarPrices } from './stored-bar-prices.js';
import type { BrokerAdapter } from './types.js';

/**
 * Resolves the broker adapter for a portfolio.
 *
 * The registry is the only place that maps an environment to an implementation,
 * and it refuses to hand back an adapter whose environment differs from the
 * portfolio's — the structural guarantee behind "demo credentials can never
 * place a live trade" (§3).
 */
export class BrokerRegistry {
  private readonly demoBrokers = new Map<string, DemoBroker>();
  private readonly paperBrokers = new Map<string, PaperBroker>();
  private readonly liveBrokers = new Map<string, RobinhoodBroker>();

  /**
   * @param options.now Injectable clock, handed to the simulated venues.
   *   A test that had to wait for the real market to open could not assert a
   *   fill at all, and the same reasoning that makes the trading gate's
   *   instant an input applies here.
   */
  constructor(
    private readonly options: {
      seed?: number;
      db?: PrismaClient;
      now?: () => number;
      /**
       * The live transport, when one exists. Absent on every deployment that
       * has no Robinhood credentials, which is all of them today.
       */
      robinhood?: RobinhoodTransport;
      /**
       * Per-account consent to place live orders, separate from
       * `ALLOW_LIVE_TRADING`. Both must be true, and the broker's own
       * `agentic_allowed` flag on top of that.
       */
      liveOrdersEnabled?: boolean;
    } = {},
  ) {}

  forPortfolio(portfolio: Pick<Portfolio, 'id' | 'environment' | 'initialCapital'>): BrokerAdapter {
    const environment = portfolio.environment as TradingEnvironment;

    switch (environment) {
      case TradingEnvironment.DEMO: {
        let broker = this.demoBrokers.get(portfolio.id);
        if (!broker) {
          broker = new DemoBroker({
            accountId: `DEMO-${portfolio.id.slice(0, 8)}`,
            startingCash: portfolio.initialCapital.toString(),
            seed: this.options.seed ?? config().DEMO_SEED,
            ...(this.options.now && { now: this.options.now }),
          });
          this.demoBrokers.set(portfolio.id, broker);
        }
        assertSameEnvironment(environment, broker.environment, 'BrokerRegistry.forPortfolio');
        return broker;
      }

      case TradingEnvironment.PAPER: {
        const db = this.options.db;
        if (!db) {
          // The paper venue prices from stored bars, so without a database
          // there is nothing to match against. Saying so beats quoting a
          // price from nowhere.
          throw new AppError(
            'NOT_IMPLEMENTED',
            'This registry was built without a database, so the paper venue has no prices.',
          );
        }
        let paper = this.paperBrokers.get(portfolio.id);
        if (!paper) {
          paper = new PaperBroker({
            accountId: `PAPER-${portfolio.id.slice(0, 8)}`,
            startingCash: portfolio.initialCapital.toString(),
            prices: new StoredBarPrices(db),
            ...(this.options.now && { now: this.options.now }),
          });
          this.paperBrokers.set(portfolio.id, paper);
        }
        assertSameEnvironment(environment, paper.environment, 'BrokerRegistry.forPortfolio');
        return paper;
      }

      case TradingEnvironment.LIVE: {
        // Reading a live account is allowed even when trading it is not:
        // reconciliation has to be able to see an account it may not touch.
        const transport = this.options.robinhood ?? new UnconfiguredRobinhoodTransport();
        let live = this.liveBrokers.get(portfolio.id);
        if (!live) {
          live = new RobinhoodBroker({
            accountNumber: portfolio.id,
            transport,
            liveOrdersEnabled: this.options.liveOrdersEnabled ?? false,
            allowLiveTrading: config().ALLOW_LIVE_TRADING,
            ...(this.options.now && { now: this.options.now }),
          });
          this.liveBrokers.set(portfolio.id, live);
        }
        assertSameEnvironment(environment, live.environment, 'BrokerRegistry.forPortfolio');
        return live;
      }

      default:
        throw new AppError('INTERNAL', `Unknown trading environment ${String(environment)}`);
    }
  }

  /** True when a portfolio's environment has a working adapter today. */
  isSupported(environment: TradingEnvironment): boolean {
    return (
      environment === TradingEnvironment.DEMO ||
      (environment === TradingEnvironment.PAPER && this.options.db !== undefined)
    );
  }

  demoBrokerFor(portfolioId: string): DemoBroker | undefined {
    return this.demoBrokers.get(portfolioId);
  }

  paperBrokerFor(portfolioId: string): PaperBroker | undefined {
    return this.paperBrokers.get(portfolioId);
  }

  reset(): void {
    this.demoBrokers.clear();
    this.paperBrokers.clear();
    this.liveBrokers.clear();
  }
}
