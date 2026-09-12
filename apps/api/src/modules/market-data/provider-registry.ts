import { config } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';
import { MassiveProvider } from './massive-provider.js';
import type { MarketDataProvider } from './types.js';

/**
 * Resolves the configured market-data provider.
 *
 * Mirrors `BrokerRegistry`: one place maps configuration to an implementation,
 * and an unconfigured provider is refused rather than substituted. Falling back
 * to the demo simulator here would let a PAPER or LIVE strategy trade on
 * simulated prices while believing they were real — the market-data equivalent
 * of demo credentials reaching a live venue.
 */
export class MarketDataProviderRegistry {
  private cached: MarketDataProvider | null = null;

  /** The configured provider, or null when none is configured. */
  tryResolve(): MarketDataProvider | null {
    const cfg = config();
    if (cfg.MARKET_DATA_PROVIDER === 'NONE') return null;

    if (!this.cached) {
      // The config loader has already refused POLYGON without a key, so this
      // cannot be reached with an empty credential.
      this.cached = new MassiveProvider({
        apiKey: cfg.MASSIVE_API_KEY as string,
        baseUrl: cfg.MASSIVE_BASE_URL,
        timeoutMs: cfg.MASSIVE_TIMEOUT_MS,
        isDelayed: cfg.MASSIVE_IS_DELAYED,
      });
    }
    return this.cached;
  }

  /** The configured provider, or a 503 explaining that none is configured. */
  resolve(): MarketDataProvider {
    const provider = this.tryResolve();
    if (!provider) {
      throw new AppError(
        'SERVICE_DEGRADED',
        'No market-data provider is configured. Set MARKET_DATA_PROVIDER and its credentials.',
      );
    }
    return provider;
  }

  /** Test helper — never called from application code. */
  reset(): void {
    this.cached = null;
  }
}
