import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
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
  await user.type(input, name);
}

function renderForm(contextOverrides: Partial<DashboardContextValue> = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const contextValue: DashboardContextValue = {
    fighterSprites: [mario, luigi],
    fighter: mario,
    setFighter: vi.fn(),
    ...contextOverrides,
  };
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <DashboardContext.Provider value={contextValue}>
          <AddMatchForm />
        </DashboardContext.Provider>
      </AuthProvider>
    </QueryClientProvider>,
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

  it('requires an opponent name before submitting', async () => {
    const user = userEvent.setup();
    renderForm();

    await user.click(screen.getByRole('button', { name: 'Add Match' }));
    const dialog = await screen.findByRole('dialog');

    await user.click(within(dialog).getByRole('radio', { name: 'Win' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect(await within(dialog).findByText('Opponent name is required')).toBeInTheDocument();
    expect(createMatch).not.toHaveBeenCalled();
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

  it('disables the trigger when the user has no fighters selected', () => {
    renderForm({ fighterSprites: [], fighter: undefined });
    expect(screen.getByRole('button', { name: 'Add Match' })).toBeDisabled();
  });
});
