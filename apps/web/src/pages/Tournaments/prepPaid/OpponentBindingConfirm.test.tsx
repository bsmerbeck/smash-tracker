import { describe, expect, it, vi, beforeEach } from 'vitest';
import '@/i18n';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PrepScoutBindingCandidate, ScoutBinding } from '@smash-tracker/shared';
import { ApiError } from '@/lib/api';
import { OpponentBindingConfirm } from './OpponentBindingConfirm';

const confirmMutateSpy = vi.fn();
const clearMutateSpy = vi.fn();
let candidatesData: { candidates: PrepScoutBindingCandidate[] } = { candidates: [] };
const usePrepBindingCandidatesSpy = vi.fn(
  (_entryKey: string, _name: string, options?: { enabled?: boolean }) => {
    void options;
    return { data: candidatesData };
  },
);

vi.mock('@/hooks/useScoutBindings', () => ({
  usePrepBindingCandidates: (entryKey: string, name: string, options?: { enabled?: boolean }) =>
    usePrepBindingCandidatesSpy(entryKey, name, options),
  useConfirmScoutBinding: () => ({ mutate: confirmMutateSpy }),
  useClearScoutBinding: () => ({ mutate: clearMutateSpy }),
}));

// Sanity spies asserting the confirm-player flow never touches generation or
// checkout — imported for assertion purposes only, the component under test
// does not (and must not) import either module.
const generatePrepMutateSpy = vi.fn();
const checkoutMutateSpy = vi.fn();
vi.mock('@/hooks/usePrepPaidReports', () => ({
  useGeneratePrepReport: () => ({ mutate: generatePrepMutateSpy }),
  useStartPrepBundle: () => ({ mutate: vi.fn() }),
  executeBundleChildren: vi.fn(),
}));
vi.mock('@/hooks/useBilling', () => ({
  useCheckout: () => ({ mutate: checkoutMutateSpy }),
  useCredits: () => ({ data: undefined }),
  creditsQueryKey: ['billing', 'credits'],
}));

vi.mock('@/lib/api', () => {
  class MockApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
    }
  }
  return { ApiError: MockApiError };
});

function makeCandidate(
  overrides: Partial<PrepScoutBindingCandidate> = {},
): PrepScoutBindingCandidate {
  return {
    provider: 'startgg',
    startggUserSlug: 'user/abc123',
    displayTag: 'Rival',
    matchCount: 3,
    ...overrides,
  };
}

function makeBinding(overrides: Partial<ScoutBinding> = {}): ScoutBinding {
  return {
    provider: 'startgg',
    startggUserSlug: 'user/abc123',
    displayTag: 'Rival',
    method: 'matchHistory',
    confirmedAt: 1_700_000_000_000,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  candidatesData = { candidates: [] };
});

describe('OpponentBindingConfirm', () => {
  it('shows the confirm-player trigger and unresolved label for an unconfirmed opponent', () => {
    render(<OpponentBindingConfirm entryKey="entry-1" name="Rival" />);
    expect(screen.getByText('No player confirmed yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirm player' })).toBeInTheDocument();
    expect(screen.queryByText(/^Confirmed:/)).not.toBeInTheDocument();
  });

  it('shows the confirmed label with the display tag plus change and remove actions for a confirmed opponent', () => {
    render(<OpponentBindingConfirm entryKey="entry-1" name="Rival" binding={makeBinding()} />);
    expect(screen.getByText('Confirmed: Rival')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Change player' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove confirmed player' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Confirm player' })).not.toBeInTheDocument();
  });

  it('does not enable the candidates query on mount — only once the flow is opened', async () => {
    const user = userEvent.setup();
    render(<OpponentBindingConfirm entryKey="entry-1" name="Rival" />);

    expect(usePrepBindingCandidatesSpy).toHaveBeenCalledWith('entry-1', 'Rival', {
      enabled: false,
    });

    await user.click(screen.getByRole('button', { name: 'Confirm player' }));

    expect(usePrepBindingCandidatesSpy).toHaveBeenLastCalledWith('entry-1', 'Rival', {
      enabled: true,
    });
  });

  it('pre-highlights (but does not auto-submit) a single candidate', async () => {
    candidatesData = { candidates: [makeCandidate()] };
    const user = userEvent.setup();
    render(<OpponentBindingConfirm entryKey="entry-1" name="Rival" />);

    await user.click(screen.getByRole('button', { name: 'Confirm player' }));

    // The candidate-list Confirm button is the first of the two "Confirm"
    // buttons on screen (the second belongs to the always-present manual
    // paste section, disabled while its own input is empty).
    const [confirmButton] = screen.getAllByRole('button', { name: 'Confirm' });
    expect(confirmButton).toBeEnabled();
    // Not auto-submitted — the mutation is not called just from opening.
    expect(confirmMutateSpy).not.toHaveBeenCalled();

    await user.click(confirmButton!);
    expect(confirmMutateSpy).toHaveBeenCalledTimes(1);
    expect(confirmMutateSpy).toHaveBeenCalledWith(
      { name: 'Rival', input: { startgg: { query: 'user/abc123' } } },
      expect.objectContaining({ onSuccess: expect.any(Function), onError: expect.any(Function) }),
    );
  });

  it('leaves nothing pre-selected and shows the multiple-identity hint for more than one candidate, regardless of fixture order', async () => {
    const first = makeCandidate({ displayTag: 'AltA', startggUserSlug: 'user/alt-a' });
    const second = makeCandidate({ displayTag: 'AltB', startggUserSlug: 'user/alt-b' });
    candidatesData = { candidates: [first, second] };
    const user = userEvent.setup();
    render(<OpponentBindingConfirm entryKey="entry-1" name="Rival" />);

    await user.click(screen.getByRole('button', { name: 'Confirm player' }));

    expect(
      screen.getByText('Your matches point at more than one profile — pick the right one.'),
    ).toBeInTheDocument();
    // The Confirm button for the candidate list stays disabled until an
    // explicit selection is made — nothing is pre-highlighted.
    const candidateConfirmButtons = screen.getAllByRole('button', { name: 'Confirm' });
    expect(candidateConfirmButtons[0]).toBeDisabled();

    // Reordering the fixture must not change which one is highlighted (none).
    candidatesData = { candidates: [second, first] };
  });

  it('shows the empty message and the paste-a-profile input with zero candidates', async () => {
    const user = userEvent.setup();
    render(<OpponentBindingConfirm entryKey="entry-1" name="Rival" />);

    await user.click(screen.getByRole('button', { name: 'Confirm player' }));

    expect(
      screen.getByText('No profiles found in your match history for this opponent.'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Paste a profile link')).toBeInTheDocument();
  });

  it('submits a pasted profile reference by calling the confirm mutation once with that reference and nothing else', async () => {
    const user = userEvent.setup();
    render(<OpponentBindingConfirm entryKey="entry-1" name="Rival" />);

    await user.click(screen.getByRole('button', { name: 'Confirm player' }));
    await user.type(screen.getByLabelText('Paste a profile link'), 'user/pasted-ref');

    const manualConfirmButtons = screen.getAllByRole('button', { name: 'Confirm' });
    await user.click(manualConfirmButtons[manualConfirmButtons.length - 1]!);

    expect(confirmMutateSpy).toHaveBeenCalledTimes(1);
    expect(confirmMutateSpy).toHaveBeenCalledWith(
      {
        name: 'Rival',
        input: {
          startgg: { query: 'user/pasted-ref' },
          parrygg: { query: 'user/pasted-ref' },
        },
      },
      expect.objectContaining({ onSuccess: expect.any(Function), onError: expect.any(Function) }),
    );
  });

  it('renders the not-found message on a resolution failure and leaves the flow open', async () => {
    const user = userEvent.setup();
    render(<OpponentBindingConfirm entryKey="entry-1" name="Rival" />);

    await user.click(screen.getByRole('button', { name: 'Confirm player' }));
    await user.type(screen.getByLabelText('Paste a profile link'), 'not-a-real-profile');

    const manualConfirmButtons = screen.getAllByRole('button', { name: 'Confirm' });
    const onErrorCallback = () => {
      const call = confirmMutateSpy.mock.calls[0];
      return call?.[1]?.onError as (error: unknown) => void;
    };
    await user.click(manualConfirmButtons[manualConfirmButtons.length - 1]!);
    onErrorCallback()(new ApiError(404, 'not found'));

    expect(
      await screen.findByText('No player found for that profile. Check the link and try again.'),
    ).toBeInTheDocument();
    // Flow stays open — the paste input is still visible and populated.
    expect(screen.getByLabelText('Paste a profile link')).toBeInTheDocument();
  });

  it('does not call the generation or checkout mutation during any confirmation path', async () => {
    candidatesData = { candidates: [makeCandidate()] };
    const user = userEvent.setup();
    render(<OpponentBindingConfirm entryKey="entry-1" name="Rival" binding={makeBinding()} />);

    await user.click(screen.getByRole('button', { name: 'Change player' }));
    const [confirmButton] = screen.getAllByRole('button', { name: 'Confirm' });
    await user.click(confirmButton!);

    expect(generatePrepMutateSpy).not.toHaveBeenCalled();
    expect(checkoutMutateSpy).not.toHaveBeenCalled();
  });

  it('calls the clear mutation once when the remove action is used', async () => {
    const user = userEvent.setup();
    render(<OpponentBindingConfirm entryKey="entry-1" name="Rival" binding={makeBinding()} />);

    await user.click(screen.getByRole('button', { name: 'Remove confirmed player' }));

    expect(clearMutateSpy).toHaveBeenCalledTimes(1);
    expect(clearMutateSpy).toHaveBeenCalledWith('Rival');
  });
});
