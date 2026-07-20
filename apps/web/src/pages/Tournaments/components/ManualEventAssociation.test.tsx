import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiError } from '@/lib/api';
import { ManualEventAssociation } from './ManualEventAssociation';

const manualEntry = vi.fn();

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
      tournaments: { manualEntry: (...args: unknown[]) => manualEntry(...args) },
    },
    ApiError: MockApiError,
  };
});

function renderForm(onSuccess?: () => void) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ManualEventAssociation onSuccess={onSuccess} />
    </QueryClientProvider>,
  );
}

describe('ManualEventAssociation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('D-05: submits the event name to POST /api/tournaments/manual-entry and calls onSuccess', async () => {
    const user = userEvent.setup();
    manualEntry.mockResolvedValue({
      eventName: 'Locals #42',
      firstSetAt: 1,
      lastSetAt: 1,
      setsPlayed: 0,
      source: 'manual',
      entryKey: 'manual-locals-42-abc123',
    });
    const onSuccess = vi.fn();

    renderForm(onSuccess);

    await user.type(screen.getByLabelText('Event name'), 'Locals #42');
    await user.click(screen.getByRole('button', { name: 'Associate event' }));

    await waitFor(() =>
      expect(manualEntry).toHaveBeenCalledWith({ eventName: 'Locals #42', eventDate: undefined }),
    );
    await waitFor(() => expect(onSuccess).toHaveBeenCalled());
  });

  it('shows an inline error and does not call onSuccess when the request fails', async () => {
    const user = userEvent.setup();
    manualEntry.mockRejectedValue(new ApiError(500, 'server exploded'));
    const onSuccess = vi.fn();

    renderForm(onSuccess);

    await user.type(screen.getByLabelText('Event name'), 'Locals #42');
    await user.click(screen.getByRole('button', { name: 'Associate event' }));

    expect(await screen.findByText('server exploded')).toBeInTheDocument();
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it('disables submit until a non-empty event name is entered', () => {
    renderForm();
    expect(screen.getByRole('button', { name: 'Associate event' })).toBeDisabled();
  });
});
