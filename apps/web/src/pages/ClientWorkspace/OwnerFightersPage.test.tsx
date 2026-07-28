import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from '@/context/AuthContext';
import { OwnerFightersPage } from './OwnerFightersPage';
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

const getFighters = vi.fn();
const saveFighters = vi.fn();
const workspacesList = vi.fn();

vi.mock('@/lib/api', () => ({
  api: {
    users: {
      getFighters: (...args: unknown[]) => getFighters(...args),
      saveFighters: (...args: unknown[]) => saveFighters(...args),
    },
    clientWorkspaces: {
      list: (...args: unknown[]) => workspacesList(...args),
    },
  },
}));

function renderFighters(initialPath = '/workspace/t1/fighters') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialPath]}>
        <AuthProvider>
          <Routes>
            <Route path="/workspace/:tenantId/fighters" element={<OwnerFightersPage />} />
            <Route path="/workspace/:tenantId/overview" element={<div>Overview page</div>} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('OwnerFightersPage', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    setMockUser(makeMockUser());
    workspacesList.mockResolvedValue([
      { tenantId: 't1', label: 'My Workspace', claimedAt: 1, delegateCoachUid: null },
    ]);
    getFighters.mockResolvedValue({ primary: [], secondary: [] });
    saveFighters.mockResolvedValue({ primary: [1], secondary: [] });
  });

  it('renders both a Primary and a Secondary fighter-selection grid', async () => {
    renderFighters();

    expect(await screen.findByText('My Workspace — Fighters')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Primary' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Secondary' })).toBeInTheDocument();
    expect(screen.getAllByAltText('Mario')).toHaveLength(2);
  });

  // 260726-r4 (P0): a save on a combined page must NOT navigate away.
  it('saves the primary selection through the subject-scoped saveFighters mutation and stays on the page', async () => {
    const user = userEvent.setup();
    renderFighters();

    await waitFor(() => expect(screen.getAllByAltText('Mario')).toHaveLength(2));

    const [primaryMario] = screen.getAllByAltText('Mario');
    if (!primaryMario) throw new Error('expected a primary Mario tile');
    await user.click(primaryMario);

    const saveButtons = screen.getAllByRole('button', { name: 'Save' });
    const primarySave = saveButtons[0];
    if (!primarySave) throw new Error('expected a primary Save button');
    await user.click(primarySave);

    await waitFor(() => expect(saveFighters).toHaveBeenCalledTimes(1));
    expect(saveFighters).toHaveBeenCalledWith({ primary: [1], secondary: [] });

    expect(screen.queryByText('Overview page')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Primary' })).toBeInTheDocument();
  });

  // 260726-r4 (P0 data-loss fix): the exact reported bug — "Saving
  // secondaries wipes out primary fighters" — reproduced on the owner
  // workspace surface too (Phase 24 inherited the pre-existing pattern).
  it('preserves an already-set primary selection when saving secondaries', async () => {
    const user = userEvent.setup();
    getFighters.mockResolvedValue({ primary: [1, 10], secondary: [] });
    renderFighters();

    await waitFor(() => expect(screen.getAllByAltText('Peach')).toHaveLength(2));

    const [, secondaryPeach] = screen.getAllByAltText('Peach');
    if (!secondaryPeach) throw new Error('expected a secondary Peach tile');
    await user.click(secondaryPeach);

    const saveButtons = screen.getAllByRole('button', { name: 'Save' });
    const secondarySave = saveButtons[1];
    if (!secondarySave) throw new Error('expected a secondary Save button');
    await user.click(secondarySave);

    await waitFor(() => expect(saveFighters).toHaveBeenCalledTimes(1));
    expect(saveFighters).toHaveBeenCalledWith({ primary: [1, 10], secondary: [14] });
  });

  it('blocks saving while the fighters query is unresolved', async () => {
    getFighters.mockReturnValue(new Promise(() => {})); // never resolves
    renderFighters();

    expect(await screen.findByText('My Workspace — Fighters')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
    expect(saveFighters).not.toHaveBeenCalled();
  });
});
