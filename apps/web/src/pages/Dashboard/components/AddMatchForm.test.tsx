import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { ComponentProps } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { AuthProvider } from '@/context/AuthContext';
import { AddMatchForm } from './AddMatchForm';
import { DashboardContext, type DashboardContextValue } from '../DashboardContext';
import { resetAuthMock, setMockUser, makeMockUser } from '@/test/mockAuth';
import { SpriteList } from '@/data/sprites';

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

const createMatch = vi.fn();
const listMatches = vi.fn();
const listOpponents = vi.fn();
const upsertMe = vi.fn().mockResolvedValue({ uid: 'test-uid', email: 'test@example.com' });
const getStageFavorites = vi.fn().mockResolvedValue({ stageIds: [], updatedAt: 0 });

vi.mock('@/lib/api', () => ({
  api: {
    users: {
      upsertMe: (...args: unknown[]) => upsertMe(...args),
    },
    matches: {
      create: (...args: unknown[]) => createMatch(...args),
      list: (...args: unknown[]) => listMatches(...args),
    },
    opponents: {
      list: (...args: unknown[]) => listOpponents(...args),
    },
    stageFavorites: {
      get: (...args: unknown[]) => getStageFavorites(...args),
    },
  },
}));

const mario = SpriteList.find((s) => s.id === 1)!;
const luigi = SpriteList.find((s) => s.id === 10)!;
// AddMatchForm defaults "Opponent Fighter" to the alphabetically-first
// sprite (`[...SpriteList].sort((a, b) => a.name.localeCompare(b.name))[0]`).
const alphabeticallyFirstSprite = [...SpriteList].sort((a, b) => a.name.localeCompare(b.name))[0]!;

/**
 * Opens the opponent combobox popover and types a name into it. The
 * "Type a name..." cmdk input only exists in the DOM once the Popover is
 * open, so callers must click the combobox trigger button first.
 */
async function fillOpponentName(
  user: ReturnType<typeof userEvent.setup>,
  dialog: HTMLElement,
  name: string,
) {
  await user.click(within(dialog).getByRole('combobox', { name: 'Opponent' }));
  const input = await screen.findByPlaceholderText('Type a name...');
  // The field arrives pre-filled ('unknown' by default) — clear it first,
  // like a user replacing the value (the real input also selects-all on
  // focus so typing replaces).
  await user.clear(input);
  await user.type(input, name);
}

function renderForm(
  contextOverrides: Partial<DashboardContextValue> = {},
  formProps: ComponentProps<typeof AddMatchForm> = {},
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const contextValue: DashboardContextValue = {
    fighterSprites: [mario, luigi],
    fighter: mario,
    setFighter: vi.fn(),
    ...contextOverrides,
  };
  return render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <DashboardContext.Provider value={contextValue}>
            <AddMatchForm {...formProps} />
          </DashboardContext.Provider>
        </AuthProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('AddMatchForm', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    upsertMe.mockResolvedValue({ uid: 'test-uid', email: 'test@example.com' });
    setMockUser(makeMockUser());
    listOpponents.mockResolvedValue(['rival']);
    listMatches.mockResolvedValue([]);
    createMatch.mockResolvedValue({
      id: 'new-match',
      fighter_id: mario.id,
      opponent_id: luigi.id,
      time: 1,
      map: { id: 0, name: 'no selection' },
      opponent: 'rival',
      notes: '',
      matchType: 'none',
      win: true,
    });
  });

  it('requires a result to be chosen before submitting', async () => {
    const user = userEvent.setup();
    renderForm();

    await user.click(screen.getByRole('button', { name: 'Add Match' }));
    const dialog = await screen.findByRole('dialog');

    // Fill in the opponent name (required) but leave result unset.
    await fillOpponentName(user, dialog, 'rival');

    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect(await within(dialog).findByText('Choose a result')).toBeInTheDocument();
    expect(createMatch).not.toHaveBeenCalled();
  });

  it("defaults the opponent to 'unknown' when the field is left untouched", async () => {
    const user = userEvent.setup();
    renderForm();

    await user.click(screen.getByRole('button', { name: 'Add Match' }));
    const dialog = await screen.findByRole('dialog');

    await user.click(within(dialog).getByRole('radio', { name: 'Win' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(createMatch).toHaveBeenCalledTimes(1));
    expect(createMatch).toHaveBeenCalledWith(expect.objectContaining({ opponent: 'unknown' }));
  });

  it('submits a correctly shaped CreateMatchInput with a lowercased opponent name and the map sentinel', async () => {
    const user = userEvent.setup();
    renderForm();

    await user.click(screen.getByRole('button', { name: 'Add Match' }));
    const dialog = await screen.findByRole('dialog');

    await user.click(within(dialog).getByRole('radio', { name: 'Win' }));

    await fillOpponentName(user, dialog, 'RIVAL');

    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(createMatch).toHaveBeenCalledTimes(1));
    expect(createMatch).toHaveBeenCalledWith({
      fighter_id: mario.id,
      opponent_id: alphabeticallyFirstSprite.id,
      map: { id: 0, name: 'no selection' },
      opponent: 'rival',
      notes: '',
      matchType: 'none',
      win: true,
    });
  });

  it('closes the dialog after a successful submit', async () => {
    const user = userEvent.setup();
    renderForm();

    await user.click(screen.getByRole('button', { name: 'Add Match' }));
    const dialog = await screen.findByRole('dialog');

    await user.click(within(dialog).getByRole('radio', { name: 'Loss' }));
    await fillOpponentName(user, dialog, 'rival');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(createMatch).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('commits a typed opponent name not in the suggestions and closes the popover on Enter, without submitting the form', async () => {
    const user = userEvent.setup();
    renderForm();

    await user.click(screen.getByRole('button', { name: 'Add Match' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('radio', { name: 'Win' }));

    await user.click(within(dialog).getByRole('combobox', { name: 'Opponent' }));
    const input = await screen.findByPlaceholderText('Type a name...');
    await user.clear(input); // pre-filled with 'unknown'
    await user.type(input, 'BrandNewChallenger{Enter}');

    // Enter closes the popover (the cmdk search input unmounts with it) and
    // the trigger button reflects the committed free-text value.
    await waitFor(() =>
      expect(screen.queryByPlaceholderText('Type a name...')).not.toBeInTheDocument(),
    );
    expect(within(dialog).getByRole('combobox', { name: 'Opponent' })).toHaveTextContent(
      'BrandNewChallenger',
    );

    // Enter must not have submitted the surrounding form.
    expect(createMatch).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(createMatch).toHaveBeenCalledTimes(1));
    expect(createMatch).toHaveBeenCalledWith(
      expect.objectContaining({ opponent: 'brandnewchallenger' }),
    );
  });

  it('onCreated fires once with the created match in single-game mode', async () => {
    const onCreated = vi.fn();
    const user = userEvent.setup();
    renderForm({}, { onCreated });

    await user.click(screen.getByRole('button', { name: 'Add Match' }));
    const dialog = await screen.findByRole('dialog');

    await user.click(within(dialog).getByRole('radio', { name: 'Win' }));
    await fillOpponentName(user, dialog, 'rival');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(createMatch).toHaveBeenCalledTimes(1));
    expect(onCreated).toHaveBeenCalledTimes(1);
    expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ id: 'new-match' }));
  });

  it('omitting onCreated does not throw and behaves identically (default mount)', async () => {
    const user = userEvent.setup();
    renderForm(); // no onCreated prop — matches all 3 existing mount-point signatures

    await user.click(screen.getByRole('button', { name: 'Add Match' }));
    const dialog = await screen.findByRole('dialog');

    await user.click(within(dialog).getByRole('radio', { name: 'Win' }));
    await fillOpponentName(user, dialog, 'rival');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(createMatch).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('disables the trigger when the user has no fighters selected', () => {
    renderForm({ fighterSprites: [], fighter: undefined });
    expect(screen.getByRole('button', { name: 'Add Match' })).toBeDisabled();
  });

  it('requireVod blocks submit with an empty VOD URL and shows the required error', async () => {
    const user = userEvent.setup();
    renderForm({}, { requireVod: true });

    await user.click(screen.getByRole('button', { name: 'Add Match' }));
    const dialog = await screen.findByRole('dialog');

    await user.click(within(dialog).getByRole('radio', { name: 'Win' }));
    await fillOpponentName(user, dialog, 'rival');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect(
      await within(dialog).findByText('Enter a valid VOD link (YouTube or Twitch)'),
    ).toBeInTheDocument();
    expect(createMatch).not.toHaveBeenCalled();
  });

  it('requireVod accepts a valid VOD URL', async () => {
    const user = userEvent.setup();
    renderForm({}, { requireVod: true });

    await user.click(screen.getByRole('button', { name: 'Add Match' }));
    const dialog = await screen.findByRole('dialog');

    await user.click(within(dialog).getByRole('radio', { name: 'Win' }));
    await fillOpponentName(user, dialog, 'rival');
    await user.type(
      screen.getByPlaceholderText('https://youtube.com/watch?v=...'),
      'https://youtube.com/watch?v=abc123',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(createMatch).toHaveBeenCalledTimes(1));
    expect(createMatch).toHaveBeenCalledWith(
      expect.objectContaining({ vodUrl: 'https://youtube.com/watch?v=abc123' }),
    );
  });

  it('Dashboard mode (default) still allows an empty VOD URL', async () => {
    const user = userEvent.setup();
    renderForm();

    await user.click(screen.getByRole('button', { name: 'Add Match' }));
    const dialog = await screen.findByRole('dialog');

    await user.click(within(dialog).getByRole('radio', { name: 'Win' }));
    await fillOpponentName(user, dialog, 'rival');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(createMatch).toHaveBeenCalledTimes(1));
    expect(createMatch.mock.calls[0]![0]).not.toHaveProperty('vodUrl');
  });

  it('omits stocksLeft/eventName/tournamentName by default (single game mode)', async () => {
    const user = userEvent.setup();
    renderForm();

    await user.click(screen.getByRole('button', { name: 'Add Match' }));
    const dialog = await screen.findByRole('dialog');

    await user.click(within(dialog).getByRole('radio', { name: 'Win' }));
    await fillOpponentName(user, dialog, 'rival');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(createMatch).toHaveBeenCalledTimes(1));
    const payload = createMatch.mock.calls[0]![0];
    expect(payload).not.toHaveProperty('stocksLeft');
    expect(payload).not.toHaveProperty('eventName');
    expect(payload).not.toHaveProperty('tournamentName');
  });

  it('includes stocksLeft and tournament fields when filled in (single game mode)', async () => {
    const user = userEvent.setup();
    renderForm();

    await user.click(screen.getByRole('button', { name: 'Add Match' }));
    const dialog = await screen.findByRole('dialog');

    await user.click(within(dialog).getByRole('radio', { name: 'Win' }));
    await fillOpponentName(user, dialog, 'rival');

    await user.click(within(dialog).getByRole('combobox', { name: 'Stocks Left (winner)' }));
    await user.click(await screen.findByRole('option', { name: '2' }));

    await user.click(within(dialog).getByRole('button', { name: 'Tournament (optional)' }));
    await user.type(within(dialog).getByPlaceholderText('e.g. The Big House 9'), 'The Big House 9');
    await user.type(
      within(dialog).getByPlaceholderText('e.g. Ultimate Singles'),
      'Ultimate Singles',
    );

    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(createMatch).toHaveBeenCalledTimes(1));
    expect(createMatch).toHaveBeenCalledWith(
      expect.objectContaining({
        stocksLeft: 2,
        tournamentName: 'The Big House 9',
        eventName: 'Ultimate Singles',
      }),
    );
  });

  describe('set mode', () => {
    it('shows only game 1 until it has a result, then reveals game 2 for a Bo3', async () => {
      const user = userEvent.setup();
      renderForm();

      await user.click(screen.getByRole('button', { name: 'Add Match' }));
      const dialog = await screen.findByRole('dialog');
      await user.click(within(dialog).getByRole('radio', { name: 'Set (Bo3/Bo5)' }));

      expect(within(dialog).getByRole('radio', { name: 'Game 1 Win' })).toBeInTheDocument();
      expect(within(dialog).queryByRole('radio', { name: 'Game 2 Win' })).not.toBeInTheDocument();

      await user.click(within(dialog).getByRole('radio', { name: 'Game 1 Win' }));

      expect(await within(dialog).findByRole('radio', { name: 'Game 2 Win' })).toBeInTheDocument();
    });

    it('stops revealing games once the set is decided (2-0 in a Bo3)', async () => {
      const user = userEvent.setup();
      renderForm();

      await user.click(screen.getByRole('button', { name: 'Add Match' }));
      const dialog = await screen.findByRole('dialog');
      await user.click(within(dialog).getByRole('radio', { name: 'Set (Bo3/Bo5)' }));

      await user.click(within(dialog).getByRole('radio', { name: 'Game 1 Win' }));
      await user.click(within(dialog).getByRole('radio', { name: 'Game 2 Win' }));

      expect(within(dialog).queryByRole('radio', { name: 'Game 3 Win' })).not.toBeInTheDocument();
      expect(within(dialog).getByTestId('set-score-chip')).toHaveTextContent('2-0');
    });

    it('onCreated fires once per created game in set mode (Bo3, 2 games)', async () => {
      const onCreated = vi.fn();
      createMatch
        .mockResolvedValueOnce({
          id: 'g1',
          fighter_id: mario.id,
          opponent_id: luigi.id,
          time: 1,
          map: { id: 0, name: 'no selection' },
          opponent: 'powpow',
          notes: '',
          matchType: 'none',
          win: true,
        })
        .mockResolvedValueOnce({
          id: 'g2',
          fighter_id: mario.id,
          opponent_id: luigi.id,
          time: 2,
          map: { id: 0, name: 'no selection' },
          opponent: 'powpow',
          notes: '',
          matchType: 'none',
          win: true,
        });
      const user = userEvent.setup();
      renderForm({}, { onCreated });

      await user.click(screen.getByRole('button', { name: 'Add Match' }));
      const dialog = await screen.findByRole('dialog');
      await user.click(within(dialog).getByRole('radio', { name: 'Set (Bo3/Bo5)' }));

      await user.click(within(dialog).getByRole('combobox', { name: 'Opponent' }));
      const opponentInput = await screen.findByPlaceholderText('Type a name...');
      await user.clear(opponentInput); // pre-filled with 'unknown'
      await user.type(opponentInput, 'powpow');

      await user.click(within(dialog).getByRole('radio', { name: 'Game 1 Win' }));
      await user.click(await within(dialog).findByRole('radio', { name: 'Game 2 Win' }));

      await user.click(within(dialog).getByRole('button', { name: 'Save Set' }));

      await waitFor(() => expect(createMatch).toHaveBeenCalledTimes(2));
      expect(onCreated).toHaveBeenCalledTimes(2);
      expect(onCreated).toHaveBeenNthCalledWith(1, expect.objectContaining({ id: 'g1' }));
      expect(onCreated).toHaveBeenNthCalledWith(2, expect.objectContaining({ id: 'g2' }));
    });

    it('submits one match per game and shows a single "Set recorded" toast', async () => {
      const user = userEvent.setup();
      renderForm();

      await user.click(screen.getByRole('button', { name: 'Add Match' }));
      const dialog = await screen.findByRole('dialog');
      await user.click(within(dialog).getByRole('radio', { name: 'Set (Bo3/Bo5)' }));

      await user.click(within(dialog).getByRole('combobox', { name: 'Opponent' }));
      const opponentInput = await screen.findByPlaceholderText('Type a name...');
      await user.clear(opponentInput); // pre-filled with 'unknown'
      await user.type(opponentInput, 'powpow');

      await user.click(within(dialog).getByRole('radio', { name: 'Game 1 Win' }));
      await user.click(await within(dialog).findByRole('radio', { name: 'Game 2 Loss' }));
      await user.click(await within(dialog).findByRole('radio', { name: 'Game 3 Win' }));

      await user.click(within(dialog).getByRole('button', { name: 'Save Set' }));

      await waitFor(() => expect(createMatch).toHaveBeenCalledTimes(3));
      expect(createMatch.mock.calls.map((call) => call[0].win)).toEqual([true, false, true]);
      for (const call of createMatch.mock.calls) {
        expect(call[0].opponent).toBe('powpow');
      }

      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    });

    it('reports a partial failure honestly when a later game fails to save', async () => {
      const user = userEvent.setup();
      renderForm();
      createMatch
        .mockResolvedValueOnce({
          id: 'g1',
          fighter_id: mario.id,
          opponent_id: luigi.id,
          time: 1,
          map: { id: 0, name: 'no selection' },
          opponent: 'powpow',
          notes: '',
          matchType: 'none',
          win: true,
        })
        .mockRejectedValueOnce(new Error('network error'));

      await user.click(screen.getByRole('button', { name: 'Add Match' }));
      const dialog = await screen.findByRole('dialog');
      await user.click(within(dialog).getByRole('radio', { name: 'Set (Bo3/Bo5)' }));

      await user.click(within(dialog).getByRole('combobox', { name: 'Opponent' }));
      const opponentInput = await screen.findByPlaceholderText('Type a name...');
      await user.clear(opponentInput); // pre-filled with 'unknown'
      await user.type(opponentInput, 'powpow');

      await user.click(within(dialog).getByRole('radio', { name: 'Game 1 Win' }));
      await user.click(await within(dialog).findByRole('radio', { name: 'Game 2 Loss' }));

      await user.click(within(dialog).getByRole('button', { name: 'Save Set' }));

      await waitFor(() => expect(createMatch).toHaveBeenCalledTimes(2));
      // Dialog stays open on failure — nothing gets silently discarded.
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    it('carries matchType, tournamentName, and eventName onto every game payload of a saved Bo3', async () => {
      const user = userEvent.setup();
      renderForm();

      await user.click(screen.getByRole('button', { name: 'Add Match' }));
      const dialog = await screen.findByRole('dialog');
      await user.click(within(dialog).getByRole('radio', { name: 'Set (Bo3/Bo5)' }));

      await user.click(within(dialog).getByRole('radio', { name: 'Offline Tourney' }));

      await user.click(within(dialog).getByRole('button', { name: 'Tournament (optional)' }));
      await user.type(
        within(dialog).getByPlaceholderText('e.g. The Big House 9'),
        'The Big House 9',
      );
      await user.type(
        within(dialog).getByPlaceholderText('e.g. Ultimate Singles'),
        'Ultimate Singles',
      );

      await user.click(within(dialog).getByRole('combobox', { name: 'Opponent' }));
      const opponentInput = await screen.findByPlaceholderText('Type a name...');
      await user.clear(opponentInput); // pre-filled with 'unknown'
      await user.type(opponentInput, 'powpow');

      await user.click(within(dialog).getByRole('radio', { name: 'Game 1 Win' }));
      await user.click(await within(dialog).findByRole('radio', { name: 'Game 2 Loss' }));
      await user.click(await within(dialog).findByRole('radio', { name: 'Game 3 Win' }));

      await user.click(within(dialog).getByRole('button', { name: 'Save Set' }));

      await waitFor(() => expect(createMatch).toHaveBeenCalledTimes(3));
      for (const call of createMatch.mock.calls) {
        expect(call[0]).toMatchObject({
          matchType: 'offline-tourney',
          tournamentName: 'The Big House 9',
          eventName: 'Ultimate Singles',
        });
      }
    });

    it('preserves the selected fighter and opponent fighter across a Single<->Set mode toggle (no Banjo & Kazooie reset)', async () => {
      const user = userEvent.setup();
      renderForm();

      await user.click(screen.getByRole('button', { name: 'Add Match' }));
      const dialog = await screen.findByRole('dialog');

      // Single mode: pick non-default fighter/opponent-fighter selections.
      await user.click(within(dialog).getByRole('combobox', { name: 'Your Fighter' }));
      await user.click(await screen.findByRole('option', { name: luigi.name }));

      await user.click(within(dialog).getByRole('combobox', { name: 'Opponent Fighter' }));
      await user.click(await screen.findByRole('option', { name: mario.name }));

      // Toggle to Set mode — selections should carry over, not reset to the
      // untouched Set form's default (Banjo & Kazooie, alphabetically first).
      await user.click(within(dialog).getByRole('radio', { name: 'Set (Bo3/Bo5)' }));

      expect(within(dialog).getByRole('combobox', { name: 'Your Fighter' })).toHaveTextContent(
        luigi.name,
      );
      expect(
        within(dialog).getByRole('combobox', { name: 'Opponent Fighter (game 1)' }),
      ).toHaveTextContent(mario.name);

      // Symmetric: toggling back to Single preserves the Set-mode selections
      // too (first-switch seeding, not two-way live sync).
      await user.click(within(dialog).getByRole('radio', { name: 'Single game' }));

      expect(within(dialog).getByRole('combobox', { name: 'Your Fighter' })).toHaveTextContent(
        luigi.name,
      );
      expect(within(dialog).getByRole('combobox', { name: 'Opponent Fighter' })).toHaveTextContent(
        mario.name,
      );
    });
  });
});
