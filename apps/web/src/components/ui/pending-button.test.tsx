import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act, render } from '@testing-library/react';
import { PendingButton, SPINNER_DELAY_MS, TOAST_DELAY_MS } from './pending-button';

const toastLoading = vi.fn();
const toastDismiss = vi.fn();
vi.mock('sonner', () => ({
  toast: {
    loading: (...args: unknown[]) => toastLoading(...args),
    dismiss: (...args: unknown[]) => toastDismiss(...args),
  },
}));

describe('PendingButton', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders children, is not disabled, and shows no spinner when pending is false', () => {
    const { container, getByRole } = render(<PendingButton pending={false}>Save</PendingButton>);
    expect(getByRole('button', { name: 'Save' })).not.toBeDisabled();
    expect(container.querySelector('.animate-spin')).not.toBeInTheDocument();
  });

  it('disables the button immediately when pending flips true, but shows no spinner before the delay', async () => {
    const { container, getByRole } = render(<PendingButton pending={true}>Save</PendingButton>);
    expect(getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(container.querySelector('.animate-spin')).not.toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SPINNER_DELAY_MS - 1);
    });
    expect(container.querySelector('.animate-spin')).not.toBeInTheDocument();
  });

  it('shows the spinner once pending has held past the ~400ms threshold', async () => {
    const { container, getByRole } = render(<PendingButton pending={true}>Save</PendingButton>);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SPINNER_DELAY_MS);
    });

    expect(container.querySelector('.animate-spin')).toBeInTheDocument();
    expect(getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('removes the spinner and re-enables the button when pending clears', async () => {
    const { container, getByRole, rerender } = render(
      <PendingButton pending={true}>Save</PendingButton>,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SPINNER_DELAY_MS);
    });
    expect(container.querySelector('.animate-spin')).toBeInTheDocument();

    rerender(<PendingButton pending={false}>Save</PendingButton>);

    expect(container.querySelector('.animate-spin')).not.toBeInTheDocument();
    expect(getByRole('button', { name: 'Save' })).not.toBeDisabled();
  });

  it('fires a sonner toast.loading once pending has held past ~2000ms when pendingToastLabel is set', async () => {
    render(
      <PendingButton pending={true} pendingToastLabel="Saving…">
        Save
      </PendingButton>,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(TOAST_DELAY_MS - 1);
    });
    expect(toastLoading).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(toastLoading).toHaveBeenCalledTimes(1);
    expect(toastLoading).toHaveBeenCalledWith('Saving…', { id: expect.any(String) });
  });

  it('never fires a toast when pendingToastLabel is omitted', async () => {
    render(<PendingButton pending={true}>Save</PendingButton>);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(TOAST_DELAY_MS + 1000);
    });

    expect(toastLoading).not.toHaveBeenCalled();
  });

  it('dismisses the toast when pending clears', async () => {
    const { rerender } = render(
      <PendingButton pending={true} pendingToastLabel="Saving…">
        Save
      </PendingButton>,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(TOAST_DELAY_MS);
    });
    expect(toastLoading).toHaveBeenCalledTimes(1);

    rerender(
      <PendingButton pending={false} pendingToastLabel="Saving…">
        Save
      </PendingButton>,
    );

    expect(toastDismiss).toHaveBeenCalled();
  });
});
