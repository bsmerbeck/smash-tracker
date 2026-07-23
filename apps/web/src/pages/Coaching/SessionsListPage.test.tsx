import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { SessionDeliveryListItem, SessionResponse } from '@/lib/api';
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

const sessionsList = vi.fn();
const sessionsCreate = vi.fn();
const deliveriesList = vi.fn();
const deliveriesCreate = vi.fn();
const deliveriesRevoke = vi.fn();

vi.mock('@/lib/api', () => ({
  api: {
    coaching: {
      sessions: {
        list: (...args: unknown[]) => sessionsList(...args),
        create: (...args: unknown[]) => sessionsCreate(...args),
        deliveries: {
          list: (...args: unknown[]) => deliveriesList(...args),
          create: (...args: unknown[]) => deliveriesCreate(...args),
          revoke: (...args: unknown[]) => deliveriesRevoke(...args),
        },
      },
    },
  },
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { AuthProvider } from '@/context/AuthContext';
import { SessionsListPage } from './SessionsListPage';

function makeSession(overrides: Partial<SessionResponse> = {}): SessionResponse {
  return {
    sessionId: 's1',
    date: 1_700_000_000_000,
    characterTags: [8],
    summary: '',
    homework: [],
    linkedMatchIds: null,
    coachPrivateNotes: null,
    createdAt: 1_700_000_000_000,
    lastEditedAt: 1_700_000_000_000,
    ...overrides,
  };
}

function makeDelivery(overrides: Partial<SessionDeliveryListItem> = {}): SessionDeliveryListItem {
  return {
    deliveryId: 'd1',
    status: 'delivered',
    token: 'tok1',
    createdAt: 1_700_000_000_000,
    revokedAt: null,
    url: 'https://grandfinals.gg/r/tok1',
    ...overrides,
  };
}

function SessionComposerStub() {
  const location = useLocation();
  return <div data-testid="session-composer-stub">{location.pathname}</div>;
}

function renderList(initialPath = '/coach/tetra/sessions') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialPath]}>
        <AuthProvider>
          <Routes>
            <Route path="/coach/:clientId">
              <Route path="sessions" element={<SessionsListPage />} />
              <Route path="sessions/:sessionId" element={<SessionComposerStub />} />
            </Route>
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('SessionsListPage', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    setMockUser(makeMockUser());
    deliveriesList.mockResolvedValue([]);
  });

  it('shows the row date, character tags, and homework progress', async () => {
    sessionsList.mockResolvedValue([
      makeSession({
        characterTags: [8],
        homework: [
          { id: 'h1', text: 'Practice ledgetraps', done: true },
          { id: 'h2', text: 'Fix roll habit', done: false },
        ],
      }),
    ]);
    renderList();

    expect(await screen.findByText(/Session —/)).toBeInTheDocument();
    expect(screen.getByText('Fox')).toBeInTheDocument();
    expect(screen.getByText('1/2 tasks done')).toBeInTheDocument();
  });

  it('shows "No homework" for a session with an empty checklist', async () => {
    sessionsList.mockResolvedValue([makeSession({ homework: [] })]);
    renderList();

    expect(await screen.findByText('No homework')).toBeInTheDocument();
  });

  it('renders a separate Open button and delivery overflow menu — never a merged control', async () => {
    sessionsList.mockResolvedValue([makeSession()]);
    renderList();

    expect(await screen.findByRole('button', { name: 'Open' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delivery and more actions' })).toBeInTheDocument();
  });

  it('Open navigates straight to the composer for that session', async () => {
    sessionsList.mockResolvedValue([makeSession({ sessionId: 's-open' })]);
    const user = userEvent.setup();
    renderList();

    await user.click(await screen.findByRole('button', { name: 'Open' }));

    expect(await screen.findByTestId('session-composer-stub')).toHaveTextContent(
      '/coach/tetra/sessions/s-open',
    );
  });

  it('Deliver mints a delivery and copies the link', async () => {
    sessionsList.mockResolvedValue([makeSession()]);
    deliveriesCreate.mockResolvedValue({
      deliveryId: 'd1',
      token: 'tok1',
      url: 'https://x/r/tok1',
    });
    const user = userEvent.setup();
    renderList();

    await user.click(await screen.findByRole('button', { name: 'Delivery and more actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Deliver' }));

    await waitFor(() => expect(deliveriesCreate).toHaveBeenCalledWith('tetra', 's1'));
  });

  it('Revoke fires the revoke mutation for the active (non-revoked) delivery', async () => {
    sessionsList.mockResolvedValue([makeSession()]);
    deliveriesList.mockResolvedValue([makeDelivery({ deliveryId: 'd-active' })]);
    const user = userEvent.setup();
    renderList();

    await user.click(await screen.findByRole('button', { name: 'Delivery and more actions' }));
    const revokeItem = await screen.findByRole('menuitem', { name: 'Revoke link' });
    await waitFor(() => expect(revokeItem).not.toHaveAttribute('aria-disabled', 'true'));
    await user.click(revokeItem);

    await waitFor(() => expect(deliveriesRevoke).toHaveBeenCalledWith('tetra', 's1', 'd-active'));
  });

  it('+ New session creates a fresh session and navigates to its composer', async () => {
    sessionsList.mockResolvedValue([]);
    sessionsCreate.mockResolvedValue(makeSession({ sessionId: 's-new' }));
    const user = userEvent.setup();
    renderList();

    await user.click(await screen.findByRole('button', { name: '+ New session' }));

    expect(await screen.findByTestId('session-composer-stub')).toHaveTextContent(
      '/coach/tetra/sessions/s-new',
    );
  });

  it('shows the empty state when there are no sessions yet', async () => {
    sessionsList.mockResolvedValue([]);
    renderList();

    expect(
      await screen.findByText(
        'No sessions yet. Log one to start tracking homework and deliver it to your client.',
      ),
    ).toBeInTheDocument();
  });
});
