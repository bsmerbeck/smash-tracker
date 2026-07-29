import { useState } from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PrepManualEntryDialog, parseLocalCalendarDate } from './PrepManualEntryDialog';

const manualEntry = vi.fn();
vi.mock('@/lib/api', () => ({
  api: {
    tournaments: { manualEntry: (...args: unknown[]) => manualEntry(...args) },
  },
}));

const activateMutate = vi.fn();
vi.mock('@/hooks/usePrepBrief', () => ({
  useActivatePrepBrief: () => ({
    mutate: (...args: unknown[]) => activateMutate(...args),
    isPending: false,
  }),
}));

const navigate = vi.fn();
vi.mock('react-router', () => ({
  useNavigate: () => navigate,
}));

function renderNode(node: React.ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>);
}

function renderDialog(onOpenChange = vi.fn()) {
  return {
    ...renderNode(<PrepManualEntryDialog open onOpenChange={onOpenChange} />),
    onOpenChange,
  };
}

function futureDateString(daysAhead = 30): string {
  const date = new Date();
  date.setDate(date.getDate() + daysAhead);
  return date.toISOString().slice(0, 10);
}

function ControlledDialog() {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        reopen
      </button>
      <PrepManualEntryDialog open={open} onOpenChange={setOpen} />
    </>
  );
}

describe('parseLocalCalendarDate', () => {
  it('D-05: parses a YYYY-MM-DD string to LOCAL midnight of that exact calendar day, not a UTC-shifted day', () => {
    const ms = parseLocalCalendarDate('2026-01-15');
    expect(ms).not.toBeNull();
    const parsed = new Date(ms!);
    // The assertion that would have caught the off-by-one-day UTC bug: the
    // returned timestamp's LOCAL year/month/date must match the input
    // string's three parts exactly, regardless of the host's timezone
    // (including timezones west of UTC, where `new Date('2026-01-15')`
    // would render as 2026-01-14 local).
    expect(parsed.getFullYear()).toBe(2026);
    expect(parsed.getMonth()).toBe(0);
    expect(parsed.getDate()).toBe(15);
  });

  it('returns null for a malformed or empty value', () => {
    expect(parseLocalCalendarDate('')).toBeNull();
    expect(parseLocalCalendarDate('not-a-date')).toBeNull();
    expect(parseLocalCalendarDate('2026-13-40')).toBeNull();
  });
});

describe('PrepManualEntryDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('disables submit while the name is blank, the date is empty, or the date is not in the future', async () => {
    const user = userEvent.setup();
    renderDialog();
    const submit = screen.getByRole('button', { name: 'Add & start prep brief' });
    expect(submit).toBeDisabled();

    await user.type(screen.getByLabelText('Event name'), 'Locals #42');
    expect(submit).toBeDisabled();

    await user.type(screen.getByLabelText('Event date'), '2020-01-01');
    expect(submit).toBeDisabled();
  });

  it('shows the dateRequired message inline for a past date and keeps submit disabled', async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.type(screen.getByLabelText('Event name'), 'Locals #42');
    await user.type(screen.getByLabelText('Event date'), '2020-01-01');

    expect(
      screen.getByText(
        "Pick a date in the future — prep briefs are for events that haven't happened yet.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add & start prep brief' })).toBeDisabled();
  });

  it('creates the event, activates the brief, and navigates in order on a valid future date', async () => {
    const user = userEvent.setup();
    const callOrder: string[] = [];
    manualEntry.mockImplementation(async () => {
      callOrder.push('manualEntry');
      return {
        eventName: 'Locals #42',
        firstSetAt: 1,
        lastSetAt: 1,
        setsPlayed: 0,
        source: 'manual',
        entryKey: 'manual-locals-42-abc',
      };
    });
    activateMutate.mockImplementation((_vars: unknown, opts: { onSuccess: () => void }) => {
      callOrder.push('activate');
      opts.onSuccess();
    });
    navigate.mockImplementation((path: string) => callOrder.push(`navigate:${path}`));

    const { onOpenChange } = renderDialog();

    await user.type(screen.getByLabelText('Event name'), 'Locals #42');
    await user.type(screen.getByLabelText('Event date'), futureDateString());
    await user.click(screen.getByRole('button', { name: 'Add & start prep brief' }));

    await waitFor(() =>
      expect(callOrder).toEqual([
        'manualEntry',
        'activate',
        'navigate:/tournaments/manual-locals-42-abc/prep',
      ]),
    );
    expect(manualEntry).toHaveBeenCalledTimes(1);
    const input = manualEntry.mock.calls[0]?.[0] as { eventName: string; eventDate: unknown };
    expect(input.eventName).toBe('Locals #42');
    expect(typeof input.eventDate).toBe('number');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('renders prep.error.addEventFailed inline and does not navigate when manual-entry fails', async () => {
    const user = userEvent.setup();
    manualEntry.mockRejectedValue(new Error('boom'));
    renderDialog();

    await user.type(screen.getByLabelText('Event name'), 'Locals #42');
    await user.type(screen.getByLabelText('Event date'), futureDateString());
    await user.click(screen.getByRole('button', { name: 'Add & start prep brief' }));

    expect(
      await screen.findByText('Something went wrong adding this event. Please try again.'),
    ).toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
    expect(activateMutate).not.toHaveBeenCalled();
  });

  it('retries activation on the same entryKey after a failed activation, without re-creating the entry (WR-03)', async () => {
    const user = userEvent.setup();
    manualEntry.mockResolvedValue({
      eventName: 'Locals #42',
      firstSetAt: 1,
      lastSetAt: 1,
      setsPlayed: 0,
      source: 'manual',
      entryKey: 'manual-locals-42-abc',
    });
    activateMutate.mockImplementation((_vars: unknown, opts: { onError: () => void }) => {
      opts.onError();
    });

    renderDialog();

    await user.type(screen.getByLabelText('Event name'), 'Locals #42');
    await user.type(screen.getByLabelText('Event date'), futureDateString());
    await user.click(screen.getByRole('button', { name: 'Add & start prep brief' }));

    await waitFor(() => expect(activateMutate).toHaveBeenCalledTimes(1));
    expect(manualEntry).toHaveBeenCalledTimes(1);
    expect(
      await screen.findByText('Something went wrong adding this event. Please try again.'),
    ).toBeInTheDocument();

    // Retry: this time activation succeeds. Clicking submit again must
    // retry activation on the SAME entryKey rather than calling
    // manualEntry.mutate() again (which would orphan the first entry and
    // create a second, distinct one).
    activateMutate.mockImplementation((_vars: unknown, opts: { onSuccess: () => void }) => {
      opts.onSuccess();
    });
    await user.click(screen.getByRole('button', { name: 'Add & start prep brief' }));

    await waitFor(() => expect(activateMutate).toHaveBeenCalledTimes(2));
    expect(manualEntry).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith('/tournaments/manual-locals-42-abc/prep');
  });

  it('retries activation on the same entryKey after closing and reopening the dialog following a failed activation (WR-02 residual)', async () => {
    const user = userEvent.setup();
    manualEntry.mockResolvedValue({
      eventName: 'Locals #42',
      firstSetAt: 1,
      lastSetAt: 1,
      setsPlayed: 0,
      source: 'manual',
      entryKey: 'manual-locals-42-abc',
    });
    activateMutate.mockImplementation((_vars: unknown, opts: { onError: () => void }) => {
      opts.onError();
    });

    renderNode(<ControlledDialog />);

    await user.type(screen.getByLabelText('Event name'), 'Locals #42');
    await user.type(screen.getByLabelText('Event date'), futureDateString());
    await user.click(screen.getByRole('button', { name: 'Add & start prep brief' }));

    await waitFor(() => expect(activateMutate).toHaveBeenCalledTimes(1));
    expect(manualEntry).toHaveBeenCalledTimes(1);
    expect(
      await screen.findByText('Something went wrong adding this event. Please try again.'),
    ).toBeInTheDocument();

    // Close the dialog (Escape) after the failed activation, then reopen it.
    // The entry is already created server-side; closing must NOT clear the
    // pending-activation entryKey, or reopening + submitting would call
    // manualEntry.mutate() again and orphan the first entry.
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByLabelText('Event name')).not.toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'reopen' }));
    await screen.findByLabelText('Event name');

    activateMutate.mockImplementation((_vars: unknown, opts: { onSuccess: () => void }) => {
      opts.onSuccess();
    });
    // A direct submit-event dispatch (rather than a synthesized click) is
    // used here: Radix's Dialog re-mounts a fresh <form> subtree on reopen,
    // and jsdom does not reliably run the browser's implicit
    // click-a-submit-button-inside-a-form default action against a
    // just-remounted node in this test harness. Dispatching `submit`
    // directly still exercises the exact `onSubmit={handleSubmit}` handler
    // under test.
    const form = screen.getByRole('button', { name: 'Add & start prep brief' }).closest('form')!;
    fireEvent.submit(form);

    await waitFor(() => expect(activateMutate).toHaveBeenCalledTimes(2));
    expect(manualEntry).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith('/tournaments/manual-locals-42-abc/prep');
  });

  it('resets fields and error when the dialog is closed and reopened', async () => {
    const user = userEvent.setup();
    renderNode(<ControlledDialog />);

    await user.type(screen.getByLabelText('Event name'), 'Locals #42');
    expect(screen.getByLabelText('Event name')).toHaveValue('Locals #42');

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByLabelText('Event name')).not.toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'reopen' }));
    expect(await screen.findByLabelText('Event name')).toHaveValue('');
  });
});
