import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { toast } from 'sonner';
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

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// Destination stubs — the bare client root (the CORRECT CFLOW-01/02 target),
// the old `/vods` regression target, and the client fighters page (the
// fighter-setup nudge toast's action destination) — so a re-introduced
// `/vods` suffix or a wrong toast-action target routes somewhere OBSERVABLY
// different rather than 404ing silently.
function RootStub() {
  const location = useLocation();
  return <div data-testid="root-stub">{location.pathname}</div>;
}

function VodsStub() {
  const location = useLocation();
  return <div data-testid="vods-stub">{location.pathname}</div>;
}

function FightersStub() {
  const location = useLocation();
  return <div data-testid="fighters-stub">{location.pathname}</div>;
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
            <Route path="/coach/:clientId/fighters" element={<FightersStub />} />
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

  // Fighter-setup UX nudge: additive to the bare-root navigation above — a
  // success toast whose action routes to this client's fighters page,
  // without disrupting the ClientOverviewPage activation checklist landing.
  it('fires a "Client created" toast with a Set fighters action that navigates to the client fighters page', async () => {
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

    await screen.findByTestId('root-stub');
    expect(toast.success).toHaveBeenCalledWith(
      'Client created',
      expect.objectContaining({
        action: expect.objectContaining({ label: 'Set fighters', onClick: expect.any(Function) }),
      }),
    );

    const [, options] = (toast.success as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      { action: { onClick: () => void } },
    ];
    options.action.onClick();

    expect(await screen.findByTestId('fighters-stub')).toHaveTextContent('/coach/tetra/fighters');
  });
});
