import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  resolveTournamentTier,
  TIER_OVERRIDE_CONTRACT_VERSION,
  type TierEntryFields,
  type TournamentEntry,
} from '@smash-tracker/shared';
import { TooltipProvider } from '@/components/ui/tooltip';
import { TierOverrideSection } from './TierOverrideSection';

vi.mock('@/lib/firebase', async () => {
  const mock = await import('@/test/mockAuth');
  return mock.firebaseLibMock();
});

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock('sonner', () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
  },
}));

type Entry = Pick<TournamentEntry, 'entryKey' | 'tierOverride'>;

const fetchMock = vi.fn();

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Renders the section with the resolution the detail page would compute for `fields`. */
function renderSection(entry: Entry, fields: TierEntryFields) {
  const resolution = resolveTournamentTier({
    entry: { ...fields, tierOverride: entry.tierOverride },
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <TierOverrideSection entry={entry} resolution={resolution} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

const OFFLINE_412: TierEntryFields = {
  eventName: 'Regional Weekly',
  isOnline: false,
  numEntrants: 412,
};

function lastRequest(): { url: string; method: string; body: unknown } {
  const call = fetchMock.mock.calls.at(-1) as [string, RequestInit];
  return {
    url: call[0],
    method: String(call[1].method),
    body: JSON.parse(String(call[1].body)),
  };
}

describe('TierOverrideSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('E6 empty: shows the resolved badge and provenance, the placeholder, no Clear button and no Event override badge', () => {
    renderSection({ entryKey: 'entry-1', tierOverride: null }, OFFLINE_412);

    expect(screen.getByText('Tier for this event')).toBeInTheDocument();
    const badge = document.querySelector('[data-slot="tier-badge"]') as HTMLElement;
    expect(badge).toHaveAttribute('data-basis', 'estimated');
    expect(badge).toHaveAttribute('data-variant', 'outline');
    expect(screen.getByText('Estimated from 412 entrants')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Override tier' })).toHaveTextContent(
      'No override — use the resolved tier',
    );
    expect(screen.queryByRole('button', { name: 'Clear override' })).not.toBeInTheDocument();
    expect(screen.queryByText('Event override')).not.toBeInTheDocument();
    expect(
      screen.getByText('An override wins over every other source and can be cleared at any time.'),
    ).toBeInTheDocument();
  });

  it('choosing Major PATCHes exactly { tierOverride: { tier: "major" } } to the entry tier route and toasts success', async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(
      jsonResponse({
        entryKey: 'entry-1',
        tierOverride: {
          contractVersion: TIER_OVERRIDE_CONTRACT_VERSION,
          tier: 'major',
          setAtMs: 5,
        },
      }),
    );
    renderSection({ entryKey: 'entry-1', tierOverride: null }, OFFLINE_412);

    await user.click(screen.getByRole('combobox', { name: 'Override tier' }));
    await user.click(await screen.findByRole('option', { name: 'Major' }));

    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('Tier saved for this event.'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = lastRequest();
    expect(request.url).toMatch(/\/api\/tournaments\/entry-1\/tier$/);
    expect(request.method).toBe('PATCH');
    expect(request.body).toEqual({ tierOverride: { tier: 'major' } });
    expect(Object.keys(request.body as object)).toEqual(['tierOverride']);
    expect(Object.keys((request.body as { tierOverride: object }).tierOverride)).toEqual(['tier']);
  });

  it('E6 loading: the Select and the Clear button are disabled while the save is pending', async () => {
    const user = userEvent.setup();
    let release: (response: Response) => void = () => {};
    fetchMock.mockReturnValue(
      new Promise<Response>((resolve) => {
        release = resolve;
      }),
    );
    renderSection(
      {
        entryKey: 'entry-1',
        tierOverride: {
          contractVersion: TIER_OVERRIDE_CONTRACT_VERSION,
          tier: 'minor',
          setAtMs: 1,
        },
      },
      OFFLINE_412,
    );

    await user.click(screen.getByRole('combobox', { name: 'Override tier' }));
    await user.click(await screen.findByRole('option', { name: 'Local' }));

    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Override tier' })).toBeDisabled(),
    );
    expect(screen.getByRole('button', { name: 'Clear override' })).toBeDisabled();

    release(
      jsonResponse({
        entryKey: 'entry-1',
        tierOverride: {
          contractVersion: TIER_OVERRIDE_CONTRACT_VERSION,
          tier: 'local',
          setAtMs: 2,
        },
      }),
    );
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Override tier' })).toBeEnabled(),
    );
  });

  it('E6 error: a rejected save toasts saveFailed and the Select shows the stored value again', async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(jsonResponse({ message: 'nope' }, 500));
    renderSection(
      {
        entryKey: 'entry-1',
        tierOverride: {
          contractVersion: TIER_OVERRIDE_CONTRACT_VERSION,
          tier: 'minor',
          setAtMs: 1,
        },
      },
      OFFLINE_412,
    );
    const select = screen.getByRole('combobox', { name: 'Override tier' });
    expect(select).toHaveTextContent('Minor');

    await user.click(select);
    await user.click(await screen.findByRole('option', { name: 'Local' }));

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("Couldn't save the tier. Try again."),
    );
    expect(toastSuccess).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Override tier' })).toBeEnabled(),
    );
    expect(screen.getByRole('combobox', { name: 'Override tier' })).toHaveTextContent('Minor');
    expect(screen.getByRole('combobox', { name: 'Override tier' })).not.toHaveTextContent('Local');
  });

  it('E6 populated: an override shows the solid badge, the Event override badge, the stored word, the estimate line, and Clear sends exactly { tierOverride: null }', async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(jsonResponse({ entryKey: 'entry-1', tierOverride: null }));
    renderSection(
      {
        entryKey: 'entry-1',
        tierOverride: {
          contractVersion: TIER_OVERRIDE_CONTRACT_VERSION,
          tier: 'major',
          setAtMs: 1,
        },
      },
      OFFLINE_412,
    );

    const badge = document.querySelector('[data-slot="tier-badge"]') as HTMLElement;
    expect(badge).toHaveAttribute('data-basis', 'manual');
    expect(badge).toHaveAttribute('data-variant', 'secondary');
    expect(screen.getByText('Set manually')).toBeInTheDocument();
    expect(screen.getByText('Event override')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Override tier' })).toHaveTextContent('Major');
    expect(
      screen.getByText('Estimate would have been: Minor (Estimated from 412 entrants)'),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Clear override' }));

    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('Tier saved for this event.'));
    expect(lastRequest().body).toEqual({ tierOverride: null });
  });

  it('shows no estimate line under an override when nothing could have estimated (an online event)', () => {
    renderSection(
      {
        entryKey: 'entry-1',
        tierOverride: {
          contractVersion: TIER_OVERRIDE_CONTRACT_VERSION,
          tier: 'major',
          setAtMs: 1,
        },
      },
      { eventName: 'Online Weekly', isOnline: true, numEntrants: 900 },
    );

    expect(screen.queryByText(/Estimate would have been/)).not.toBeInTheDocument();
  });

  it('E6 partial: an override written by a newer contract is ignored whole, disclosed, and a fresh save is still allowed', async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(
      jsonResponse({
        entryKey: 'entry-1',
        tierOverride: {
          contractVersion: TIER_OVERRIDE_CONTRACT_VERSION,
          tier: 'regional',
          setAtMs: 9,
        },
      }),
    );
    renderSection(
      { entryKey: 'entry-1', tierOverride: { contractVersion: 99, tier: 'major', setAtMs: 1 } },
      OFFLINE_412,
    );

    expect(
      screen.getByText(
        "This event's saved tier was written by a newer version of the app and is not being applied.",
      ),
    ).toBeInTheDocument();
    const badge = document.querySelector('[data-slot="tier-badge"]') as HTMLElement;
    expect(badge).toHaveAttribute('data-basis', 'estimated');
    expect(screen.queryByText('Event override')).not.toBeInTheDocument();
    const select = screen.getByRole('combobox', { name: 'Override tier' });
    expect(select).toBeEnabled();

    await user.click(select);
    await user.click(await screen.findByRole('option', { name: 'Regional' }));

    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    expect(lastRequest().body).toEqual({ tierOverride: { tier: 'regional' } });
  });

  it('the Select offers the six vocabulary words with Unknown last', async () => {
    const user = userEvent.setup();
    renderSection({ entryKey: 'entry-1', tierOverride: null }, OFFLINE_412);

    await user.click(screen.getByRole('combobox', { name: 'Override tier' }));
    const options = await screen.findAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual([
      'Supermajor',
      'Major',
      'Minor',
      'Regional',
      'Local',
      'Tier unknown',
    ]);
  });
});
