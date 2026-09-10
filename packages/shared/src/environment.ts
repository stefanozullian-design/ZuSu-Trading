import { TradingEnvironment } from './enums.js';

export interface EnvironmentDescriptor {
  readonly id: TradingEnvironment;
  readonly label: string;
  readonly indicator: string;
  /** Tailwind-ish token consumed by the web client's theme map. */
  readonly tone: 'blue' | 'amber' | 'red';
  readonly usesRealMarketData: boolean;
  readonly usesRealBroker: boolean;
  readonly usesRealMoney: boolean;
  readonly requiresExplicitConfirmation: boolean;
  readonly description: string;
}

export const ENVIRONMENTS: Readonly<Record<TradingEnvironment, EnvironmentDescriptor>> =
  Object.freeze({
    DEMO: {
      id: 'DEMO',
      label: 'DEMO',
      indicator: '🔵',
      tone: 'blue',
      usesRealMarketData: false,
      usesRealBroker: false,
      usesRealMoney: false,
      requiresExplicitConfirmation: false,
      description: 'Synthetic market data and a simulated broker. Nothing leaves the machine.',
    },
    PAPER: {
      id: 'PAPER',
      label: 'PAPER',
      indicator: '🟡',
      tone: 'amber',
      usesRealMarketData: true,
      usesRealBroker: false,
      usesRealMoney: false,
      requiresExplicitConfirmation: false,
      description: 'Real market data, simulated fills with modelled slippage and commissions.',
    },
    LIVE: {
      id: 'LIVE',
      label: 'LIVE',
      indicator: '🔴',
      tone: 'red',
      usesRealMarketData: true,
      usesRealBroker: true,
      usesRealMoney: true,
      requiresExplicitConfirmation: true,
      description: 'Real market data and a real broker. Orders move real money.',
    },
  });

export function environmentDescriptor(env: TradingEnvironment): EnvironmentDescriptor {
  return ENVIRONMENTS[env];
}

export function isRealMoney(env: TradingEnvironment): boolean {
  return ENVIRONMENTS[env].usesRealMoney;
}

export class EnvironmentMismatchError extends Error {
  constructor(
    readonly expected: TradingEnvironment,
    readonly actual: TradingEnvironment,
    context: string,
  ) {
    super(
      `Environment mismatch in ${context}: expected ${expected} but got ${actual}. ` +
        'Credentials and portfolios are never allowed to cross environments.',
    );
    this.name = 'EnvironmentMismatchError';
  }
}

/**
 * Hard gate against the worst failure mode in the system: a PAPER/DEMO
 * credential being used to place a real order, or vice-versa (spec §3).
 */
export function assertSameEnvironment(
  expected: TradingEnvironment,
  actual: TradingEnvironment,
  context: string,
): void {
  if (expected !== actual) throw new EnvironmentMismatchError(expected, actual, context);
}
