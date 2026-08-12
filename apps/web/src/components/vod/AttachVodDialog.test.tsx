import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import type { Match } from '@smash-tracker/shared';
import { AttachVodDialog } from './AttachVodDialog';
import { resetAuthMock, setMockUser, makeMockUser } from '@/test/mockAuth';

vi.mock('firebase/auth', async () => {
  const mock = await import('@/test/mockAuth');
  return {
    onAuthStateChanged: mock.onAuthStateChanged,
    signInWithEmailAndPassword: mock.signInWithEmailAndPassword,
    createUserWithEmailAndPassword: mock.createUserWithEmailAndPassword,
    signInWithPopup: mock.signInWithPopup,
    getRedirectResult: mock.getRedirectResult,
    signOut: mock.signOut,
    getAuth: mock.getAuth,
    GoogleAuthProvider: mock.GoogleAuthProvider,
  };
});

vi.mock('@/lib/firebase', async () => {
  const mock = await import('@/test/mockAuth');
  return mock.firebaseLibMock();
});

import { AuthProvider } from '@/context/AuthContext';

const updateMatch = vi.fn();
/** Phase 30.2 Plan 11 (ENR-09): backs `useEnrichmentAttribution`, which the dialog now consumes for its "prefilled from source" hint. */
const enrichmentAttribution = vi.fn();

vi.mock('@/lib/api', () => ({
  api: {
    matches: {
      update: (...args: unknown[]) => updateMatch(...args),
    },
    users: {
      enrichmentAttribution: (...args: unknown[]) => enrichmentAttribution(...args),
    },
  },
}));

function baseMatch(overrides: Partial<Match> = {}): Match {
  return {
    id: 'match-1',
    fighter_id: 1,
    opponent_id: 8,
    time: 1700000000000,
    map: { id: 1, name: 'Battlefield' },
    opponent: 'rival',
    notes: 'close game',
    matchType: 'offline-tourney',
    win: true,
    ...overrides,
  };
}

function renderDialog(match: Match, onOpenChange = vi.fn()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <AttachVodDialog match={match} open onOpenChange={onOpenChange} />
        </AuthProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
  return { onOpenChange };
}

describe('AttachVodDialog', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    setMockUser(makeMockUser());
    enrichmentAttribution.mockResolvedValue({ attributions: [] });
  });

  it('renders no timestamped-notes editor — only URL + start-time fields', () => {
    renderDialog(baseMatch({ vodUrl: 'https://youtube.com/watch?v=abc123' }));

    expect(screen.getByLabelText('VOD URL (YouTube or Twitch)')).toBeInTheDocument();
    expect(screen.getByLabelText('Match start time in VOD')).toBeInTheDocument();
    expect(screen.queryByText('Timestamps')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Timestamp note')).not.toBeInTheDocument();
  });

  it('pre-seeds the start-time field from an existing vodStartSeconds, and saving untouched preserves it', async () => {
    const user = userEvent.setup();
    updateMatch.mockResolvedValue(baseMatch());
    const match = baseMatch({
      vodUrl: 'https://youtube.com/watch?v=abc123',
      vodStartSeconds: 42,
    });
    renderDialog(match);

    expect(screen.getByLabelText('Match start time in VOD')).toHaveValue('0:42');

    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(updateMatch).toHaveBeenCalledTimes(1));
    const payload = updateMatch.mock.calls[0]![1];
    expect(payload).toHaveProperty('vodStartSeconds', 42);
    expect(payload).toHaveProperty('vodUrl', 'https://youtube.com/watch?v=abc123');
  });

  it('saves a valid URL + parseable start time as vodUrl + numeric vodStartSeconds, carrying other fields through', async () => {
    const user = userEvent.setup();
    updateMatch.mockResolvedValue(baseMatch());
    const match = baseMatch({ stocksLeft: 2, eventName: 'Ultimate Singles' });
    renderDialog(match);

    await user.type(
      screen.getByLabelText('VOD URL (YouTube or Twitch)'),
      'https://youtube.com/watch?v=abc123',
    );
    await user.type(screen.getByLabelText('Match start time in VOD'), '2:41');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(updateMatch).toHaveBeenCalledTimes(1));
    expect(updateMatch).toHaveBeenCalledWith('match-1', {
      fighter_id: 1,
      opponent_id: 8,
      map: { id: 1, name: 'Battlefield' },
      opponent: 'rival',
      notes: 'close game',
      matchType: 'offline-tourney',
      win: true,
      stocksLeft: 2,
      eventName: 'Ultimate Singles',
      vodUrl: 'https://youtube.com/watch?v=abc123',
      vodStartSeconds: 161,
    });
  });

  it('clearing the URL drops both vodUrl and vodStartSeconds from the payload', async () => {
    const user = userEvent.setup();
    updateMatch.mockResolvedValue(baseMatch());
    const match = baseMatch({
      vodUrl: 'https://youtube.com/watch?v=abc123',
      vodStartSeconds: 42,
    });
    renderDialog(match);

    await user.clear(screen.getByLabelText('VOD URL (YouTube or Twitch)'));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(updateMatch).toHaveBeenCalledTimes(1));
    const payload = updateMatch.mock.calls[0]![1];
    expect(payload).not.toHaveProperty('vodUrl');
    expect(payload).not.toHaveProperty('vodStartSeconds');
  });

  it('blocks save on an unparseable start time and shows an inline error', async () => {
    const user = userEvent.setup();
    renderDialog(baseMatch());

    await user.type(
      screen.getByLabelText('VOD URL (YouTube or Twitch)'),
      'https://youtube.com/watch?v=abc123',
    );
    await user.type(screen.getByLabelText('Match start time in VOD'), 'nope');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(
      screen.getByText('Enter a time as m:ss, h:mm:ss, or seconds (or leave blank)'),
    ).toBeInTheDocument();
    expect(updateMatch).not.toHaveBeenCalled();
  });

  it('disables the start-time field while the URL is blank', () => {
    renderDialog(baseMatch());
    expect(screen.getByLabelText('Match start time in VOD')).toBeDisabled();
  });

  it('closes the dialog after a successful save', async () => {
    const user = userEvent.setup();
    updateMatch.mockResolvedValue(baseMatch());
    const { onOpenChange } = renderDialog(baseMatch());

    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  describe('Liquipedia attribution (Phase 30.2 Plan 11, ENR-09)', () => {
    it('shows a hint that the VOD field was filled from the source, with the field still fully editable', async () => {
      enrichmentAttribution.mockResolvedValue({
        attributions: [
          { matchKey: 'match-1', vod: { sourcePageUrl: 'https://liquipedia.net/smash/Some_Page' } },
        ],
      });
      renderDialog(baseMatch({ vodUrl: 'https://youtube.com/watch?v=abc123' }));

      await waitFor(() =>
        expect(screen.getByTestId('attach-vod-prefilled-hint')).toBeInTheDocument(),
      );
      const urlField = screen.getByLabelText('VOD URL (YouTube or Twitch)');
      expect(urlField).not.toBeDisabled();
    });

    // 30.2 gap-closure BLOCKER 2: a STAGE-only witness must never make this
    // dialog claim the user's own typed URL was filled in from Liquipedia.
    it('renders NO prefilled hint for a stage-only-enriched match whose VOD the user typed', async () => {
      enrichmentAttribution.mockResolvedValue({
        attributions: [
          {
            matchKey: 'match-1',
            stage: {
              sourcePageUrl: 'https://liquipedia.net/smash/Bracket_Page',
              rawStage: 'Battlefield',
              stageForm: 'normal',
            },
          },
        ],
      });
      renderDialog(baseMatch({ vodUrl: 'https://youtube.com/watch?v=user-typed' }));

      await waitFor(() => expect(enrichmentAttribution).toHaveBeenCalled());
      expect(screen.queryByTestId('attach-vod-prefilled-hint')).not.toBeInTheDocument();
    });

    it('renders no hint for an un-enriched account, byte-identical to today', async () => {
      renderDialog(baseMatch({ vodUrl: 'https://youtube.com/watch?v=abc123' }));

      await waitFor(() => expect(enrichmentAttribution).toHaveBeenCalled());
      expect(screen.queryByTestId('attach-vod-prefilled-hint')).not.toBeInTheDocument();
    });

    it('renders no hint when the field is blank, even with an attribution record present', () => {
      renderDialog(baseMatch({ vodUrl: undefined }));

      expect(screen.queryByTestId('attach-vod-prefilled-hint')).not.toBeInTheDocument();
    });
  });
});
