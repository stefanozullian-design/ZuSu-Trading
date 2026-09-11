import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { KillSwitch } from './KillSwitch';
import type { PortfolioSummary } from '@/lib/types';

const permissions = vi.hoisted(() => ({ current: [] as string[] }));

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ can: (p: string) => permissions.current.includes(p) }),
}));

function portfolio(overrides: Partial<PortfolioSummary> = {}): PortfolioSummary {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Demo Portfolio',
    environment: 'DEMO',
    clientId: null,
    clientName: null,
    baseCurrency: 'USD',
    executionMode: 'MANUAL_APPROVAL',
    tradingState: 'ACTIVE',
    isActive: true,
    cashBalance: '1000.00',
    positionsValue: '0.00',
    equity: '1000.00',
    initialCapital: '1000.00',
    dailyPnl: null,
    dailyPnlPct: null,
    openPositions: 0,
    dailyRiskUsedPct: null,
    killSwitchEngaged: false,
    ...overrides,
  };
}

function renderWithClient(node: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

describe('KillSwitch', () => {
  it('offers the stop control to anyone who may activate it', () => {
    permissions.current = ['kill_switch:activate'];
    renderWithClient(<KillSwitch portfolio={portfolio()} />);
    expect(screen.getByRole('button', { name: /stop all trading/i })).toBeInTheDocument();
  });

  it('hides the control from a read-only role', () => {
    permissions.current = ['portfolio:read'];
    const { container } = renderWithClient(<KillSwitch portfolio={portfolio()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('demands a typed reason before it will stop trading', async () => {
    permissions.current = ['kill_switch:activate'];
    const user = userEvent.setup();
    renderWithClient(<KillSwitch portfolio={portfolio()} />);

    await user.click(screen.getByRole('button', { name: /stop all trading/i }));
    const confirm = screen.getByRole('button', { name: 'Stop all trading' });
    expect(confirm).toBeDisabled();

    await user.type(screen.getByLabelText(/reason/i), 'feed looks wrong');
    expect(confirm).toBeEnabled();
  });

  it('warns that stopping leaves open positions alone', async () => {
    permissions.current = ['kill_switch:activate'];
    const user = userEvent.setup();
    renderWithClient(<KillSwitch portfolio={portfolio()} />);

    await user.click(screen.getByRole('button', { name: /stop all trading/i }));
    expect(screen.getByText(/open positions stay open/i)).toBeInTheDocument();
  });

  it('tells a manager that only an administrator can resume', () => {
    permissions.current = ['kill_switch:activate'];
    renderWithClient(<KillSwitch portfolio={portfolio({ tradingState: 'HALTED' })} />);
    expect(screen.getByText(/administrator must release it/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /resume/i })).not.toBeInTheDocument();
  });

  it('offers resume to an administrator', () => {
    permissions.current = ['kill_switch:activate', 'kill_switch:release'];
    renderWithClient(<KillSwitch portfolio={portfolio({ tradingState: 'HALTED' })} />);
    expect(screen.getByRole('button', { name: /resume trading/i })).toBeInTheDocument();
  });
});
