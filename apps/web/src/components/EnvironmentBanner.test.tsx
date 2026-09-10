import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
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
