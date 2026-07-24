import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Match, UpdateMatchInput } from '@smash-tracker/shared';
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
const listMatches = vi.fn().mockResolvedValue([]);
const listOpponents = vi.fn().mockResolvedValue([]);
const stageFavoritesGet = vi.fn().mockResolvedValue({ stageIds: [], updatedAt: 0 });
const upsertMe = vi.fn().mockResolvedValue({ uid: 'test-uid', email: 'test@example.com' });
const getFighters = vi.fn().mockResolvedValue({ primary: [], secondary: [] });

vi.mock('@/lib/api', () => ({
  api: {
    users: {
      upsertMe: (...args: unknown[]) => upsertMe(...args),
      getFighters: (...args: unknown[]) => getFighters(...args),
    },
    matches: {
      list: (...args: unknown[]) => listMatches(...args),
      update: (...args: unknown[]) => updateMatch(...args),
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
    listMatches.mockResolvedValue([]);
    listOpponents.mockResolvedValue([]);
    stageFavoritesGet.mockResolvedValue({ stageIds: [], updatedAt: 0 });
    upsertMe.mockResolvedValue({ uid: 'test-uid', email: 'test@example.com' });
    getFighters.mockResolvedValue({ primary: [mario.id], secondary: [] });
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
});
