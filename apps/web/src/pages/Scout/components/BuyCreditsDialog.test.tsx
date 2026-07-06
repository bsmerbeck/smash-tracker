import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BuyCreditsDialog } from './BuyCreditsDialog';

const billingCheckout = vi.fn();

vi.mock('@/lib/api', () => {
  class MockApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
    }
  }
  return {
    api: {
      billing: {
        checkout: (...args: unknown[]) => billingCheckout(...args),
      },
    },
    ApiError: MockApiError,
  };
});

const PACKS = [
  { id: 'pack5' as const, credits: 5, amountCents: 800, label: '5 reports' },
  { id: 'pack15' as const, credits: 15, amountCents: 2000, label: '15 reports' },
];

function renderDialog(onOpenChange = vi.fn()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <BuyCreditsDialog open onOpenChange={onOpenChange} packs={PACKS} />
    </QueryClientProvider>,
  );
  return { onOpenChange };
}

describe('BuyCreditsDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders both packs with price and per-report math', () => {
    renderDialog();

    expect(screen.getByText('5 reports')).toBeInTheDocument();
    expect(screen.getByText('15 reports')).toBeInTheDocument();
    expect(screen.getByText('$8.00')).toBeInTheDocument();
    expect(screen.getByText('$20.00')).toBeInTheDocument();
    expect(screen.getByText('$1.60 per report')).toBeInTheDocument();
    expect(screen.getByText(/\$1\.33/)).toBeInTheDocument();
  });

  it('defaults to the first pack selected', () => {
    renderDialog();
    const firstCard = screen.getByRole('button', { name: /^5 reports/ });
    expect(firstCard).toHaveAttribute('aria-pressed', 'true');
  });

  it('selecting a pack updates which card is pressed', async () => {
    const user = userEvent.setup();
    renderDialog();

    const secondCard = screen.getByRole('button', { name: /15 reports/ });
    await user.click(secondCard);

    expect(secondCard).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /^5 reports/ })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('continuing to checkout calls the checkout mutation with the selected pack', async () => {
    const user = userEvent.setup();
    billingCheckout.mockResolvedValue({ url: 'https://checkout.stripe.com/session/abc' });
    vi.stubGlobal('location', { ...window.location, assign: vi.fn() });

    renderDialog();

    await user.click(screen.getByRole('button', { name: /15 reports/ }));
    await user.click(screen.getByRole('button', { name: 'Continue to checkout' }));

    await waitFor(() => expect(billingCheckout).toHaveBeenCalledWith('pack15'));
  });

  it('shows an error message when checkout fails', async () => {
    const user = userEvent.setup();
    const { ApiError } = await import('@/lib/api');
    billingCheckout.mockRejectedValue(new ApiError(500, 'Something broke upstream'));

    renderDialog();

    await user.click(screen.getByRole('button', { name: 'Continue to checkout' }));

    expect(await screen.findByText('Something broke upstream')).toBeInTheDocument();
  });

  it('cancel calls onOpenChange(false)', async () => {
    const user = userEvent.setup();
    const { onOpenChange } = renderDialog();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
