import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BillingCard } from './BillingCard';

const useReportsConfig = vi.fn();
vi.mock('@/hooks/useScoutReports', () => ({
  useReportsConfig: () => useReportsConfig(),
}));

const useCredits = vi.fn();
vi.mock('@/hooks/useBilling', () => ({
  useCredits: () => useCredits(),
}));

const useIsDemoAccount = vi.fn(() => false);
vi.mock('@/hooks/useIsDemoAccount', () => ({
  useIsDemoAccount: () => useIsDemoAccount(),
}));

vi.mock('@/components/billing/BuyCreditsDialog', () => ({
  BuyCreditsDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="buy-credits-dialog" /> : null,
}));

function creditsWithPacks() {
  return {
    data: {
      freeAccess: false,
      balance: 3,
      packs: [{ id: 'pack5', credits: 5, amountCents: 800, label: '5 reports' }],
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useReportsConfig.mockReturnValue({ data: { enabled: true, freeAccess: false } });
  useCredits.mockReturnValue(creditsWithPacks());
  useIsDemoAccount.mockReturnValue(false);
});

/**
 * Phase 30.3 (Gate 6, owner/Codex hard gate): no Buy Credits control
 * anywhere it renders, for a demo/research account.
 */
describe('BillingCard — demo account gating', () => {
  it('hides the Buy Credits control for a demo account', () => {
    useIsDemoAccount.mockReturnValue(true);
    render(<BillingCard />);

    expect(screen.queryByRole('button', { name: /Buy credits/i })).not.toBeInTheDocument();
  });

  it('positive control: shows the Buy Credits control for an ordinary account', () => {
    useIsDemoAccount.mockReturnValue(false);
    render(<BillingCard />);

    expect(screen.getByRole('button', { name: /Buy credits/i })).toBeInTheDocument();
  });

  it('renders nothing at all when AI reports are disabled for this deployment, regardless of demo status', () => {
    useReportsConfig.mockReturnValue({ data: { enabled: false, freeAccess: false } });
    useIsDemoAccount.mockReturnValue(true);
    const { container } = render(<BillingCard />);

    expect(container).toBeEmptyDOMElement();
  });
});
