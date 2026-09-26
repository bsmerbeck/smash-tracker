import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthContext, type AuthContextValue } from '@/context/AuthContext';
import { DashboardPrepActionSlot } from './DashboardPrepActionSlot';

/**
 * Plan 39-12 (PREP-05, D-10, review C2-M4): the dashboard IS subject-mounted
 * (`renderSubjectAnalyticsRoutes()` renders it under `/coach/:clientId` and
 * `/workspace/:tenantId` too), so its prep slot carries a runtime thin gate.
 * This proves both halves of that gate under the three route families: the
 * slot renders on the personal dashboard and NOTHING under the other two,
 * and under those two it issues ZERO tournament-entries, profile and
 * prep-brief requests — "renders nothing" alone would pass even if the
 * inner hooks had run and fired their queries under someone else's prefix.
 * The query layer is real (TanStack Query over a mocked `api`), so a call
 * count here is a request count.
 */

const listTournaments = vi.fn();
const getMe = vi.fn();
const getPrep = vi.fn();

vi.mock('@/lib/api', () => ({
  api: {
    tournaments: { list: (...args: unknown[]) => listTournaments(...args) },
    users: { getMe: (...args: unknown[]) => getMe(...args) },
    prep: { get: (...args: unknown[]) => getPrep(...args) },
  },
}));

vi.mock('@/pages/Tournaments/components/PrepManualEntryDialog', () => ({
  PrepManualEntryDialog: () => null,
}));

const DAY_MS = 24 * 60 * 60 * 1000;

const PERSONAL = '/dashboard';
const COACH = '/coach/test-client/dashboard';
const WORKSPACE = '/workspace/test-tenant/dashboard';

function renderAt(initialEntry: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const auth = { user: { uid: 'test-uid' } } as unknown as AuthContextValue;
  const element = <DashboardPrepActionSlot />;
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={auth}>
        <MemoryRouter initialEntries={[initialEntry]}>
          <Routes>
            <Route path="/dashboard" element={element} />
            <Route path="/coach/:clientId/dashboard" element={element} />
            <Route path="/workspace/:tenantId/dashboard" element={element} />
          </Routes>
        </MemoryRouter>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
}

describe('Dashboard prep slot is own-account only (D-10, PREP-05)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // A reviewable past entry and no upcoming one, so the personal route
    // exercises all three reads (entries, profile, the review candidate's brief).
    listTournaments.mockResolvedValue([
      {
        entryKey: 'past',
        eventName: 'Old Locals',
        firstSetAt: Date.now() - 3 * DAY_MS,
        lastSetAt: Date.now() - 3 * DAY_MS,
        setsPlayed: 1,
        source: 'manual',
      },
    ]);
    getMe.mockResolvedValue({ uid: 'test-uid', onboardingIntent: null });
    getPrep.mockResolvedValue({ activated: true, reviewAt: Date.now() - DAY_MS });
  });

  it('renders on the personal dashboard route (control: all three reads are issued)', async () => {
    renderAt(PERSONAL);
    expect(await screen.findByTestId('dashboard-prep-action-slot')).toHaveAttribute(
      'data-state',
      'review',
    );
    expect(listTournaments).toHaveBeenCalled();
    expect(getMe).toHaveBeenCalled();
    expect(getPrep).toHaveBeenCalledWith('past');
  });

  it.each([
    ['coach', COACH],
    ['workspace', WORKSPACE],
  ])(
    'renders nothing under the %s dashboard route and issues NO tournament-entries, profile or prep-brief request',
    async (_family, route) => {
      const { container } = renderAt(route);
      await flush();

      expect(screen.queryByTestId('dashboard-prep-action-slot')).toBeNull();
      expect(container).toBeEmptyDOMElement();
      expect(listTournaments).not.toHaveBeenCalled();
      expect(getMe).not.toHaveBeenCalled();
      expect(getPrep).not.toHaveBeenCalled();
    },
  );
});
