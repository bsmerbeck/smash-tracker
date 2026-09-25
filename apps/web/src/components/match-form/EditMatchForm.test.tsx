import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { CreateMatchInput, Match, UpdateMatchInput } from '@smash-tracker/shared';
import { AuthProvider } from '@/context/AuthContext';
import { SpriteList } from '@/data/sprites';
import { EditMatchForm } from './EditMatchForm';
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

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const updateMatch = vi.fn().mockResolvedValue({});
const createMatch = vi.fn();
const listMatches = vi.fn().mockResolvedValue([]);
const listOpponents = vi.fn().mockResolvedValue([]);
const stageFavoritesGet = vi.fn().mockResolvedValue({ stageIds: [], updatedAt: 0 });
const upsertMe = vi.fn().mockResolvedValue({ uid: 'test-uid', email: 'test@example.com' });
const getFighters = vi.fn().mockResolvedValue({ primary: [], secondary: [] });
/** Phase 30.2 Plan 11 (ENR-09): backs `useEnrichmentAttribution`, which the form now consumes for its "source-owned VOD" note. */
const enrichmentAttribution = vi.fn().mockResolvedValue({ attributions: [] });

vi.mock('@/lib/api', () => ({
  api: {
    users: {
      upsertMe: (...args: unknown[]) => upsertMe(...args),
      getFighters: (...args: unknown[]) => getFighters(...args),
      enrichmentAttribution: (...args: unknown[]) => enrichmentAttribution(...args),
    },
    matches: {
      list: (...args: unknown[]) => listMatches(...args),
      update: (...args: unknown[]) => updateMatch(...args),
      create: (...args: unknown[]) => createMatch(...args),
    },
    opponents: {
      list: (...args: unknown[]) => listOpponents(...args),
    },
    stageFavorites: {
      get: (...args: unknown[]) => stageFavoritesGet(...args),
    },
  },
}));

const mario = SpriteList.find((s) => s.id === 1)!;
const luigi = SpriteList.find((s) => s.id === 10)!;

function makeMatch(overrides: Partial<Match> = {}): Match {
  return {
    id: 'm1',
    fighter_id: mario.id,
    opponent_id: luigi.id,
    time: 1_700_000_000_000,
    map: { id: 2, name: 'Battlefield', form: 'battlefield' },
    opponent: 'rival',
    notes: '',
    matchType: 'none',
    win: true,
    ...overrides,
  } as Match;
}

function renderEditMatchForm(match: Match) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <AuthProvider>
          <EditMatchForm
            match={match}
            fighterSprites={[mario, luigi]}
            open
            onOpenChange={vi.fn()}
          />
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('EditMatchForm', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    updateMatch.mockResolvedValue({});
    createMatch.mockResolvedValue(makeMatch({ id: 'new-game' }));
    listMatches.mockResolvedValue([]);
    listOpponents.mockResolvedValue([]);
    stageFavoritesGet.mockResolvedValue({ stageIds: [], updatedAt: 0 });
    upsertMe.mockResolvedValue({ uid: 'test-uid', email: 'test@example.com' });
    getFighters.mockResolvedValue({ primary: [mario.id], secondary: [] });
    enrichmentAttribution.mockResolvedValue({ attributions: [] });
    setMockUser(makeMockUser());
  });

  // 18-VERIFICATION.md Truth #4: matchToFormValues (EditMatchForm.tsx:34)
  // maps `stageForm: match.map?.form` -> prefills the toggle ->
  // matchFormValuesToInput's conditional-spread (`...(values.stageForm ? {
  // form: values.stageForm } : {})`) -> payload retains map.form. An
  // untouched save must not silently clear a previously-recorded stage form.
  it('preserves the stage form (map.form) on an untouched save', async () => {
    const user = userEvent.setup();
    renderEditMatchForm(makeMatch());

    await user.click(await screen.findByRole('button', { name: 'Save' }));

    await waitFor(() => expect(updateMatch).toHaveBeenCalled());

    const [, input] = updateMatch.mock.calls[0] as [string, UpdateMatchInput];
    expect(input.map?.form).toBe('battlefield');
    expect(input.map?.id).toBe(2);
  });

  describe('Liquipedia attribution (Phase 30.2 Plan 11, ENR-09)', () => {
    it("shows a note under the VOD input when the current value is source-owned, stating that saving makes it the user's own", async () => {
      enrichmentAttribution.mockResolvedValue({
        attributions: [
          { matchKey: 'm1', vod: { sourcePageUrl: 'https://liquipedia.net/smash/Some_Page' } },
        ],
      });
      renderEditMatchForm(makeMatch({ vodUrl: 'https://youtube.com/watch?v=abc123' }));

      expect(await screen.findByTestId('edit-match-vod-source-owned-note')).toBeInTheDocument();
    });

    it('renders no note for a user-entered value (no attribution record)', async () => {
      renderEditMatchForm(makeMatch({ vodUrl: 'https://youtube.com/watch?v=abc123' }));

      await waitFor(() => expect(enrichmentAttribution).toHaveBeenCalled());
      expect(screen.queryByTestId('edit-match-vod-source-owned-note')).not.toBeInTheDocument();
    });

    // 30.2 gap-closure BLOCKER 2.
    it('renders no note when only the STAGE was enriched — the VOD is still the user’s own', async () => {
      enrichmentAttribution.mockResolvedValue({
        attributions: [
          {
            matchKey: 'm1',
            stage: {
              sourcePageUrl: 'https://liquipedia.net/smash/Bracket_Page',
              rawStage: 'Battlefield',
              stageForm: 'normal',
            },
          },
        ],
      });
      renderEditMatchForm(makeMatch({ vodUrl: 'https://youtube.com/watch?v=user-typed' }));

      await waitFor(() => expect(enrichmentAttribution).toHaveBeenCalled());
      expect(screen.queryByTestId('edit-match-vod-source-owned-note')).not.toBeInTheDocument();
    });
  });

  describe('character/stock evidence source-owned notes (Phase 30.3 Gate 5)', () => {
    it('shows a source-owned note when the row carries character evidence from Liquipedia', async () => {
      enrichmentAttribution.mockResolvedValue({
        attributions: [
          {
            matchKey: 'm1',
            characters: { subjectRaw: 'Mario', opponentRaw: 'Luigi' },
          },
        ],
      });
      renderEditMatchForm(makeMatch());

      expect(
        await screen.findByTestId('edit-match-characters-source-owned-note'),
      ).toBeInTheDocument();
      expect(screen.queryByTestId('edit-match-stocks-source-owned-note')).not.toBeInTheDocument();
    });

    it('shows a source-owned note when the row carries stocks evidence from Liquipedia AND has a recorded stocksLeft', async () => {
      enrichmentAttribution.mockResolvedValue({
        attributions: [{ matchKey: 'm1', stocks: { stocksLeft: 2 } }],
      });
      renderEditMatchForm(makeMatch({ stocksLeft: 2 }));

      expect(await screen.findByTestId('edit-match-stocks-source-owned-note')).toBeInTheDocument();
    });

    it('shows no stocks note when the row has no recorded stocksLeft, even if evidence exists', async () => {
      enrichmentAttribution.mockResolvedValue({
        attributions: [{ matchKey: 'm1', stocks: { stocksLeft: 2 } }],
      });
      renderEditMatchForm(makeMatch({ stocksLeft: undefined }));

      await waitFor(() => expect(enrichmentAttribution).toHaveBeenCalled());
      expect(screen.queryByTestId('edit-match-stocks-source-owned-note')).not.toBeInTheDocument();
    });

    it('shows no character/stock notes for a row with no evidence at all', async () => {
      renderEditMatchForm(makeMatch({ stocksLeft: 2 }));

      await waitFor(() => expect(enrichmentAttribution).toHaveBeenCalled());
      expect(
        screen.queryByTestId('edit-match-characters-source-owned-note'),
      ).not.toBeInTheDocument();
      expect(screen.queryByTestId('edit-match-stocks-source-owned-note')).not.toBeInTheDocument();
    });
  });

  describe('Continue Set (quick-260917-l6t)', () => {
    it('Test A: shows a Continue Set control for a manually-entered match', async () => {
      renderEditMatchForm(makeMatch());

      expect(await screen.findByRole('button', { name: 'Continue Set' })).toBeInTheDocument();
    });

    it('Test B: shows no Continue Set control for a synced match (source or parseable externalId)', async () => {
      const bySource = renderEditMatchForm(makeMatch({ source: 'startgg' }));
      await screen.findByRole('button', { name: 'Save' });
      expect(screen.queryByRole('button', { name: 'Continue Set' })).not.toBeInTheDocument();
      bySource.unmount();

      renderEditMatchForm(makeMatch({ externalId: 'sgg:99:g1', source: undefined }));
      await screen.findByRole('button', { name: 'Save' });
      expect(screen.queryByRole('button', { name: 'Continue Set' })).not.toBeInTheDocument();
    });

    it('Test C: shows a loading state (never an empty set) while the matches query is unresolved', async () => {
      listMatches.mockReturnValue(new Promise<Match[]>(() => {})); // never resolves
      const user = userEvent.setup();
      renderEditMatchForm(makeMatch());

      await user.click(await screen.findByRole('button', { name: 'Continue Set' }));

      expect(await screen.findByTestId('continue-set-loading')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Save Games' })).not.toBeInTheDocument();
    });

    it('Test D: derives and locks the set’s already-saved games with a running score', async () => {
      const anchor = makeMatch({ id: 'm-anchor', time: 1_700_000_600_000, win: true });
      const sibling = makeMatch({ id: 'm-sibling', time: 1_700_000_000_000, win: false });
      listMatches.mockResolvedValue([anchor, sibling]);
      const user = userEvent.setup();
      renderEditMatchForm(anchor);

      await user.click(await screen.findByRole('button', { name: 'Continue Set' }));

      expect(await screen.findByTestId('locked-game-1')).toBeInTheDocument();
      expect(screen.getByTestId('locked-game-2')).toBeInTheDocument();
      expect(screen.getByTestId('set-score-chip')).toHaveTextContent('1-1');
      // Read-only: no result/stage inputs for the two locked games.
      expect(screen.queryByRole('radio', { name: 'Game 1 Win' })).not.toBeInTheDocument();
      expect(screen.queryByRole('radio', { name: 'Game 2 Win' })).not.toBeInTheDocument();
    });

    it('Test E: saves only the new game through the create-match mutation — the two saved games are never re-created', async () => {
      const anchor = makeMatch({
        id: 'm-anchor',
        time: 1_700_000_600_000,
        win: true,
        eventName: 'Ultimate Singles',
        tournamentName: 'The Big House 9',
        matchType: 'offline-tourney',
      });
      const sibling = makeMatch({
        id: 'm-sibling',
        time: 1_700_000_000_000,
        win: false,
        eventName: 'Ultimate Singles',
        tournamentName: 'The Big House 9',
        matchType: 'offline-tourney',
      });
      listMatches.mockResolvedValue([anchor, sibling]);
      const user = userEvent.setup();
      renderEditMatchForm(anchor);

      await user.click(await screen.findByRole('button', { name: 'Continue Set' }));
      await screen.findByTestId('locked-game-2');
      await user.click(await screen.findByRole('radio', { name: 'Game 3 Win' }));
      await user.click(screen.getByRole('button', { name: 'Save Games' }));

      await waitFor(() => expect(createMatch).toHaveBeenCalledTimes(1));
      expect(updateMatch).not.toHaveBeenCalled();
      const [payload] = createMatch.mock.calls[0] as [CreateMatchInput];
      expect(payload).toMatchObject({
        opponent: 'rival',
        eventName: 'Ultimate Singles',
        tournamentName: 'The Big House 9',
        matchType: 'offline-tourney',
      });
    });

    it('Test F: re-picking Bo3 to Bo5 after a 2-0 locked context reveals game 3', async () => {
      const anchor = makeMatch({ id: 'm-anchor', time: 1_700_000_600_000, win: true });
      const sibling = makeMatch({ id: 'm-sibling', time: 1_700_000_000_000, win: true });
      listMatches.mockResolvedValue([anchor, sibling]);
      const user = userEvent.setup();
      renderEditMatchForm(anchor);

      await user.click(await screen.findByRole('button', { name: 'Continue Set' }));
      await screen.findByTestId('locked-game-2');

      expect(screen.getByTestId('continue-set-already-decided')).toBeInTheDocument();
      expect(screen.queryByRole('radio', { name: 'Game 3 Win' })).not.toBeInTheDocument();

      await user.click(screen.getByRole('radio', { name: 'Best of 5' }));

      expect(await screen.findByRole('radio', { name: 'Game 3 Win' })).toBeInTheDocument();
    });

    it('Test G: dropping a wrongly-derived earlier game only changes local context — never stored data', async () => {
      const anchor = makeMatch({ id: 'm-anchor', time: 1_700_000_600_000, win: true });
      const sibling = makeMatch({ id: 'm-sibling', time: 1_700_000_000_000, win: false });
      listMatches.mockResolvedValue([anchor, sibling]);
      const user = userEvent.setup();
      renderEditMatchForm(anchor);

      await user.click(await screen.findByRole('button', { name: 'Continue Set' }));
      await screen.findByTestId('locked-game-2');
      expect(screen.getByTestId('set-score-chip')).toHaveTextContent('1-1');

      await user.click(screen.getByRole('button', { name: 'Remove game 1 from this set' }));

      await waitFor(() => expect(screen.queryByTestId('locked-game-2')).not.toBeInTheDocument());
      expect(screen.getByTestId('locked-game-1')).toBeInTheDocument();
      expect(screen.getByTestId('set-score-chip')).toHaveTextContent('1-0');
      expect(updateMatch).not.toHaveBeenCalled();
    });
  });
});
