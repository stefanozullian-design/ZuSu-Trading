import type { Portfolio } from '@prisma/client';
import { TradingEnvironment, assertSameEnvironment } from '@zusu/shared';
import { config } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';
import { DemoBroker } from './demo-broker.js';
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

  constructor(private readonly options: { seed?: number } = {}) {}

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
          });
          this.demoBrokers.set(portfolio.id, broker);
        }
        assertSameEnvironment(environment, broker.environment, 'BrokerRegistry.forPortfolio');
        return broker;
      }

      case TradingEnvironment.PAPER:
        throw new AppError(
          'NOT_IMPLEMENTED',
          'The paper broker arrives in Phase 5. Paper portfolios are read-only until then.',
        );

      case TradingEnvironment.LIVE:
        if (!config().ALLOW_LIVE_TRADING) {
          throw new AppError(
            'LIVE_TRADING_DISABLED',
            'Live trading is disabled on this deployment (ALLOW_LIVE_TRADING is false).',
          );
        }
        throw new AppError(
          'NOT_IMPLEMENTED',
          'The live broker adapter arrives in Phase 8. Live portfolios are read-only until then.',
        );

      default:
        throw new AppError('INTERNAL', `Unknown trading environment ${String(environment)}`);
    }
  }

  /** True when a portfolio's environment has a working adapter today. */
  isSupported(environment: TradingEnvironment): boolean {
    return environment === TradingEnvironment.DEMO;
  }

  demoBrokerFor(portfolioId: string): DemoBroker | undefined {
    return this.demoBrokers.get(portfolioId);
  }

  reset(): void {
    this.demoBrokers.clear();
  }
}
