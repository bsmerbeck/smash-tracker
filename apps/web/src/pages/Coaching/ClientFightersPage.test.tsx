import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from '@/context/AuthContext';
import { ClientFightersPage } from './ClientFightersPage';
import { resetAuthMock, setMockUser, makeMockUser } from '@/test/mockAuth';

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

const getFighters = vi.fn();
const saveFighters = vi.fn();
const clientsList = vi.fn();

vi.mock('@/lib/api', () => ({
  api: {
    users: {
      getFighters: (...args: unknown[]) => getFighters(...args),
      saveFighters: (...args: unknown[]) => saveFighters(...args),
    },
    coaching: {
      clients: { list: (...args: unknown[]) => clientsList(...args) },
    },
  },
}));

function renderFighters(initialPath = '/coach/tetra/fighters') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialPath]}>
        <AuthProvider>
          <Routes>
            <Route path="/coach/:clientId/fighters" element={<ClientFightersPage />} />
            <Route path="/coach/:clientId/overview" element={<div>Overview page</div>} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('ClientFightersPage', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    setMockUser(makeMockUser());
    clientsList.mockResolvedValue([{ clientId: 'tetra', label: 'TETRA', draftCount: 0 }]);
    getFighters.mockResolvedValue({ primary: [], secondary: [] });
    saveFighters.mockResolvedValue({ primary: [1], secondary: [] });
  });

  it('renders both a Primary and a Secondary fighter-selection grid', async () => {
    renderFighters();

    expect(await screen.findByText('TETRA — Fighters')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Primary' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Secondary' })).toBeInTheDocument();

    // Two independent selection grids exist (Mario tile appears once per grid).
    expect(screen.getAllByAltText('Mario')).toHaveLength(2);
  });

  it('saves the primary selection through the subject-scoped saveFighters mutation', async () => {
    const user = userEvent.setup();
    renderFighters();

    await waitFor(() => expect(screen.getAllByAltText('Mario')).toHaveLength(2));

    const [primaryMario] = screen.getAllByAltText('Mario');
    if (!primaryMario) throw new Error('expected a primary Mario tile');
    await user.click(primaryMario);

    const saveButtons = screen.getAllByRole('button', { name: 'Save' });
    // The first Save button belongs to the Primary section.
    const primarySave = saveButtons[0];
    if (!primarySave) throw new Error('expected a primary Save button');
    await user.click(primarySave);

    await waitFor(() => expect(saveFighters).toHaveBeenCalledTimes(1));
    expect(saveFighters).toHaveBeenCalledWith({ primary: [1], secondary: [] });

    expect(await screen.findByText('Overview page')).toBeInTheDocument();
  });
});
