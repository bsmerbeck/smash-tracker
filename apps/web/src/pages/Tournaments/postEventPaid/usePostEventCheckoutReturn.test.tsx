import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import '@/i18n';
import { act, render, screen } from '@testing-library/react';
import { MemoryRouter, useSearchParams } from 'react-router';
import { usePostEventCheckoutReturn } from './usePostEventCheckoutReturn';

const toastSuccess = vi.fn();
const toastPlain = vi.fn();
vi.mock('sonner', () => ({
  toast: Object.assign((...args: unknown[]) => toastPlain(...args), {
    success: (...args: unknown[]) => toastSuccess(...args),
  }),
}));

let creditsResult: { refetch: () => void } = { refetch: vi.fn() };
vi.mock('@/hooks/useBilling', () => ({
  useCredits: () => creditsResult,
}));

function Probe() {
  usePostEventCheckoutReturn();
  const [params] = useSearchParams();
  return <div data-testid="search-params">{params.toString()}</div>;
}

function renderProbe(initialEntries: string[]) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <Probe />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  creditsResult = { refetch: vi.fn() };
});

afterEach(() => {
  vi.useRealTimers();
});

describe('usePostEventCheckoutReturn', () => {
  it('?billing=success -> paymentReceived toast + credits re-poll + param stripped, exactly once (ref-guarded)', async () => {
    vi.useFakeTimers();
    renderProbe(['/tournaments/entry-1/prep?billing=success']);

    expect(toastSuccess).toHaveBeenCalledTimes(1);
    expect(toastSuccess).toHaveBeenCalledWith('Payment received — your plan will start shortly.');
    expect(screen.getByTestId('search-params')).toHaveTextContent('');

    act(() => {
      vi.advanceTimersByTime(2000 * 5);
    });
    expect(creditsResult.refetch).toHaveBeenCalledTimes(5);

    // Re-render churn (e.g. sibling state updates) must not re-announce —
    // the ref guard fires exactly once per mount.
    act(() => {
      vi.advanceTimersByTime(2000 * 5);
    });
    expect(creditsResult.refetch).toHaveBeenCalledTimes(5);
    expect(toastSuccess).toHaveBeenCalledTimes(1);
  });

  it('?billing=cancelled -> checkoutCancelled toast, param stripped, no re-poll', () => {
    renderProbe(['/tournaments/entry-1/prep?billing=cancelled']);

    expect(toastPlain).toHaveBeenCalledWith('Checkout cancelled.');
    expect(screen.getByTestId('search-params')).toHaveTextContent('');
    expect(creditsResult.refetch).not.toHaveBeenCalled();
  });

  it('no ?billing= param -> no toast, no param mutation', () => {
    renderProbe(['/tournaments/entry-1/prep']);

    expect(toastSuccess).not.toHaveBeenCalled();
    expect(toastPlain).not.toHaveBeenCalled();
    expect(creditsResult.refetch).not.toHaveBeenCalled();
  });
});
