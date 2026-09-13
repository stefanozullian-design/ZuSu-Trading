import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ENVIRONMENTS } from '@zusu/shared';
import { EnvironmentBanner } from './EnvironmentBanner';
import type { EnvironmentInfo } from '@/lib/types';

const environment = (overrides: Partial<EnvironmentInfo> = {}): EnvironmentInfo => ({
  environment: 'DEMO',
  label: 'DEMO',
  indicator: '🔵',
  tone: 'blue',
  description: 'Synthetic market data and a simulated broker.',
  usesRealMoney: false,
  requiresExplicitConfirmation: false,
  liveTradingAllowed: false,
  marketDataConfigured: true,
  ...overrides,
});

describe('EnvironmentBanner', () => {
  it('always names the environment out loud', () => {
    render(<EnvironmentBanner environment={environment()} />);
    expect(screen.getByRole('status')).toHaveAccessibleName('Trading environment: DEMO');
    expect(screen.getByText('DEMO')).toBeInTheDocument();
  });

  it('uses a distinct colour per environment so they are never confused', () => {
    const { container: demo } = render(<EnvironmentBanner environment={environment()} />);
    const { container: paper } = render(
      <EnvironmentBanner
        environment={environment({ environment: 'PAPER', label: 'PAPER', tone: 'amber' })}
      />,
    );
    const { container: live } = render(
      <EnvironmentBanner
        environment={environment({ environment: 'LIVE', label: 'LIVE', tone: 'red' })}
      />,
    );

    expect(demo.querySelector('.env-demo')).not.toBeNull();
    expect(paper.querySelector('.env-paper')).not.toBeNull();
    expect(live.querySelector('.env-live')).not.toBeNull();
  });

  it('says so when a live deployment cannot actually trade', () => {
    render(
      <EnvironmentBanner
        environment={environment({
          environment: 'LIVE',
          label: 'LIVE',
          tone: 'red',
          liveTradingAllowed: false,
        })}
      />,
    );
    expect(screen.getByText(/live trading is disabled/i)).toBeInTheDocument();
  });

  it('drops the warning once live trading is enabled', () => {
    render(
      <EnvironmentBanner
        environment={environment({
          environment: 'LIVE',
          label: 'LIVE',
          tone: 'red',
          liveTradingAllowed: true,
        })}
      />,
    );
    expect(screen.queryByText(/live trading is disabled/i)).not.toBeInTheDocument();
  });
});

/**
 * Why the banner follows the portfolio rather than the deployment.
 *
 * Each portfolio carries its own environment, so one installation can hold a
 * practice book and a paper one at the same time. A banner fixed to the
 * deployment default would then say "synthetic market data" over a portfolio
 * priced from the real market — false, on the one element that exists so the
 * environment can never be mistaken.
 */
describe('what the banner claims about prices', () => {
  it('describes paper as real market data', () => {
    render(
      <EnvironmentBanner
        environment={environment({
          environment: 'PAPER',
          label: 'PAPER',
          tone: 'amber',
          description: ENVIRONMENTS.PAPER.description,
        })}
      />,
    );

    expect(screen.getByRole('status')).toHaveAccessibleName('Trading environment: PAPER');
    expect(screen.getByText(/real market data/i)).toBeInTheDocument();
    expect(screen.queryByText(/synthetic/i)).toBeNull();
  });

  it('keeps the shipped wording rather than a copy that can drift', () => {
    // The descriptions live in the shared package because the API states them
    // too; a second copy here would eventually disagree with the one people
    // actually see.
    expect(ENVIRONMENTS.DEMO.description).toMatch(/synthetic/i);
    expect(ENVIRONMENTS.PAPER.description).toMatch(/real market data/i);
    expect(ENVIRONMENTS.LIVE.description).toMatch(/real money/i);
  });
});
