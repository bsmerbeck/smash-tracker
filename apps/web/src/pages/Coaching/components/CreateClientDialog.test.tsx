import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from '@/context/AuthContext';
import { resetAuthMock, setMockUser, makeMockUser } from '@/test/mockAuth';
import { CreateClientDialog } from './CreateClientDialog';

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

const clientsCreate = vi.fn();

vi.mock('@/lib/api', () => ({
  api: {
    coaching: {
      clients: {
        create: (...args: unknown[]) => clientsCreate(...args),
      },
    },
  },
}));

// Two destination stubs — one for the bare client root (the CORRECT
// CFLOW-01/02 target) and one for the old `/vods` regression target — so a
// re-introduced `/vods` suffix routes somewhere OBSERVABLY different rather
// than 404ing silently.
function RootStub() {
  const location = useLocation();
  return <div data-testid="root-stub">{location.pathname}</div>;
}

function VodsStub() {
  const location = useLocation();
  return <div data-testid="vods-stub">{location.pathname}</div>;
}

function renderDialog() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/coach']}>
        <AuthProvider>
          <Routes>
            <Route path="/coach" element={<CreateClientDialog triggerLabel="+ New client" />} />
            <Route path="/coach/:clientId" element={<RootStub />} />
            <Route path="/coach/:clientId/vods" element={<VodsStub />} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('CreateClientDialog', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    setMockUser(makeMockUser());
  });

  it('navigates to the bare client root on create-success, never the /vods VOD Manager path (CFLOW-01/02)', async () => {
    clientsCreate.mockResolvedValue({
      clientId: 'tetra',
      label: 'TETRA',
      draftCount: 0,
      lastActivityAt: null,
    });
    const user = userEvent.setup();
    renderDialog();

    await user.click(await screen.findByRole('button', { name: '+ New client' }));
    await user.type(await screen.findByLabelText('Client label'), 'TETRA');
    await user.click(await screen.findByRole('button', { name: 'Create' }));

    expect(await screen.findByTestId('root-stub')).toHaveTextContent('/coach/tetra');
    expect(screen.queryByTestId('vods-stub')).not.toBeInTheDocument();
  });
});
