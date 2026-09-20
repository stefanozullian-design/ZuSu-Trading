import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RecordTrade } from './RecordTrade';

/**
 * The entry form.
 *
 * What is worth pinning is the shape of the request rather than the pixels:
 * the server refuses a deposit that carries a share count, so a form that
 * quietly keeps one from a previous entry turns a correct entry into a
 * rejected one — and the person sees a validation error about a field that is
 * no longer on their screen.
 */

const apiMock = vi.hoisted(() => vi.fn());
const permissions = vi.hoisted(() => ({ current: ['portfolio:write'] }));

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ can: (p: string) => permissions.current.includes(p) }),
}));

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return { ...actual, api: apiMock };
});

function renderWithClient(node: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

function lastBody(): Record<string, unknown> {
  const call = apiMock.mock.calls.at(-1) as [string, { body: Record<string, unknown> }];
  return call[1].body;
}

beforeEach(() => {
  permissions.current = ['portfolio:write'];
  apiMock.mockReset();
  apiMock.mockResolvedValue({
    id: 'entry',
    type: 'BUY',
    detail: 'Recorded.',
    warnings: [],
  });
});

describe('RecordTrade', () => {
  it('sends a buy as shares and a price, and never as a cash amount', async () => {
    const user = userEvent.setup();
    renderWithClient(<RecordTrade portfolioId="p1" />);

    await user.type(screen.getByLabelText('Symbol'), 'aapl');
    await user.type(screen.getByLabelText('Shares'), '10');
    await user.type(screen.getByLabelText('Price per share'), '180.25');
    await user.click(screen.getByRole('button', { name: 'Record it' }));

    const body = lastBody();
    expect(body.type).toBe('BUY');
    // Upper-cased here so the symbol matches whatever the person typed.
    expect(body.symbol).toBe('AAPL');
    expect(body.quantity).toBe('10');
    expect(body.price).toBe('180.25');
    expect(body.amount).toBeUndefined();
  });

  it('drops the share fields when the type becomes a deposit', async () => {
    const user = userEvent.setup();
    renderWithClient(<RecordTrade portfolioId="p1" />);

    await user.type(screen.getByLabelText('Shares'), '10');
    await user.type(screen.getByLabelText('Price per share'), '180');
    await user.click(screen.getByRole('button', { name: 'Deposit' }));

    // The fields are gone from the form, and gone from the request. Sending a
    // share count with a deposit is a contradiction the server refuses rather
    // than guessing which half was meant.
    expect(screen.queryByLabelText('Shares')).toBeNull();
    expect(screen.queryByLabelText('Symbol')).toBeNull();

    await user.type(screen.getByLabelText('Amount'), '2500');
    await user.click(screen.getByRole('button', { name: 'Record it' }));

    const body = lastBody();
    expect(body.type).toBe('DEPOSIT');
    expect(body.amount).toBe('2500');
    expect(body.quantity).toBeUndefined();
    expect(body.price).toBeUndefined();
    expect(body.symbol).toBeUndefined();
  });

  it('keeps the symbol field for a dividend, because one holding paid it', async () => {
    const user = userEvent.setup();
    renderWithClient(<RecordTrade portfolioId="p1" />);

    await user.click(screen.getByRole('button', { name: 'Dividend' }));
    await user.type(screen.getByLabelText('Symbol (optional)'), 'AAPL');
    await user.type(screen.getByLabelText('Amount'), '24.50');
    await user.click(screen.getByRole('button', { name: 'Record it' }));

    const body = lastBody();
    expect(body.type).toBe('DIVIDEND');
    expect(body.symbol).toBe('AAPL');
    expect(body.amount).toBe('24.50');
  });

  it('keeps the type and the date after an entry, and clears the numbers', async () => {
    const user = userEvent.setup();
    renderWithClient(<RecordTrade portfolioId="p1" />);

    await user.click(screen.getByRole('button', { name: 'Dividend' }));
    await user.type(screen.getByLabelText('Amount'), '24.50');
    await user.click(screen.getByRole('button', { name: 'Record it' }));

    // A person entering three months of a statement re-picks nothing between
    // rows except the numbers that actually differ.
    expect(await screen.findByText('Recorded.')).toBeTruthy();
    expect((screen.getByLabelText('Amount') as HTMLInputElement).value).toBe('');
    expect(screen.getByLabelText('Date it happened')).toBeTruthy();
    expect(screen.getByLabelText('Symbol (optional)')).toBeTruthy();
  });

  it('is not offered to a reader who could not submit it', () => {
    permissions.current = [];
    const { container } = renderWithClient(<RecordTrade portfolioId="p1" />);
    // A form that always 403s is worse than no form: the cost is paid after
    // the typing rather than before it.
    expect(container.textContent).toBe('');
  });

  it('shows the warnings the server returned without treating them as failures', async () => {
    apiMock.mockResolvedValue({
      id: 'entry',
      type: 'BUY',
      detail: 'Bought 1000 AAPL.',
      warnings: ['Recorded cash is now -130000.00, which is negative.'],
    });
    const user = userEvent.setup();
    renderWithClient(<RecordTrade portfolioId="p1" />);

    await user.type(screen.getByLabelText('Symbol'), 'AAPL');
    await user.type(screen.getByLabelText('Shares'), '1000');
    await user.type(screen.getByLabelText('Price per share'), '180');
    await user.click(screen.getByRole('button', { name: 'Record it' }));

    expect(await screen.findByText('Bought 1000 AAPL.')).toBeTruthy();
    expect(screen.getByText(/which is negative/)).toBeTruthy();
  });
});
