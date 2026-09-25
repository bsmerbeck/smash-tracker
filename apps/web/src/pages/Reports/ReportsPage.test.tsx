import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from '@/context/AuthContext';
import { ReportsPage } from './ReportsPage';
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

const reportsConfig = vi.fn();
const reportsList = vi.fn();

vi.mock('@/lib/api', () => ({
  api: {
    reports: {
      config: (...args: unknown[]) => reportsConfig(...args),
      list: (...args: unknown[]) => reportsList(...args),
    },
  },
  ApiError: class MockApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
    }
  },
}));

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <ReportsPage />
      </AuthProvider>
    </QueryClientProvider>,
  );
}

const REPORT_SHAPE = {
  overview: 'overview',
  gameplan: [],
  stageStrategy: { bans: [], picks: [], reasoning: '' },
  headToHead: null,
  watchFor: [],
  confidenceNotes: '',
};

describe('ReportsPage', () => {
  beforeEach(() => {
    resetAuthMock();
    vi.clearAllMocks();
    setMockUser(makeMockUser());
  });

  it('shows a friendly note when AI reports are not enabled', async () => {
    reportsConfig.mockResolvedValue({ enabled: false });
    reportsList.mockResolvedValue([]);

    renderPage();

    expect(
      await screen.findByText(/AI reports aren't enabled for this account yet/),
    ).toBeInTheDocument();
  });

  it('shows the empty state when enabled but no reports exist', async () => {
    reportsConfig.mockResolvedValue({ enabled: true });
    reportsList.mockResolvedValue([]);

    renderPage();

    expect(await screen.findByText(/No AI scouting reports yet/)).toBeInTheDocument();
  });

  it('groups reports by player (source-aware), newest group and newest report first', async () => {
    reportsConfig.mockResolvedValue({ enabled: true });
    reportsList.mockResolvedValue([
      {
        id: 'r1',
        createdAt: 1_700_000_000_000,
        model: 'claude-opus-4-8',
        player: { id: 1802316, gamerTag: 'Pandem1c' },
        report: REPORT_SHAPE,
      },
      {
        id: 'r2',
        createdAt: 1_700_200_000_000,
        model: 'claude-opus-4-8',
        player: { id: 1802316, gamerTag: 'Pandem1c' },
        report: REPORT_SHAPE,
      },
      {
        id: 'r3',
        createdAt: 1_700_100_000_000,
        model: 'claude-opus-4-8',
        player: { gamerTag: 'PowPow', source: 'parrygg', parryUserId: 'parry-uid-1' },
        report: REPORT_SHAPE,
      },
    ]);

    renderPage();

    expect(await screen.findByText('Pandem1c')).toBeInTheDocument();
    expect(screen.getByText('PowPow')).toBeInTheDocument();
    expect(screen.getByText('parry.gg')).toBeInTheDocument();

    // Two rows: Pandem1c (2 reports grouped) and PowPow (1 report).
    const rows = screen.getAllByText(/^Pandem1c$|^PowPow$/);
    expect(rows).toHaveLength(2);
  });

  it('expands a group with multiple reports and opens an older one inline', async () => {
    const user = userEvent.setup();
    reportsConfig.mockResolvedValue({ enabled: true });
    reportsList.mockResolvedValue([
      {
        id: 'newer',
        createdAt: 1_700_200_000_000,
        model: 'claude-opus-4-8',
        player: { id: 1802316, gamerTag: 'Pandem1c' },
        report: { ...REPORT_SHAPE, overview: 'Newer overview' },
      },
      {
        id: 'older',
        createdAt: 1_700_000_000_000,
        model: 'claude-opus-4-8',
        player: { id: 1802316, gamerTag: 'Pandem1c' },
        report: { ...REPORT_SHAPE, overview: 'Older overview' },
      },
    ]);

    renderPage();
    await screen.findByText('Pandem1c');

    await user.click(screen.getByRole('button', { name: 'Show older reports' }));
    await user.click(screen.getByRole('button', { name: /Older report/ }));

    expect((await screen.findAllByText('Older overview')).length).toBeGreaterThan(0);
  });

  it('opens the newest report inline on row click', async () => {
    const user = userEvent.setup();
    reportsConfig.mockResolvedValue({ enabled: true });
    reportsList.mockResolvedValue([
      {
        id: 'r1',
        createdAt: 1_700_000_000_000,
        model: 'claude-opus-4-8',
        player: { id: 1802316, gamerTag: 'Pandem1c' },
        report: { ...REPORT_SHAPE, overview: 'The overview text' },
      },
    ]);

    renderPage();
    await user.click(await screen.findByText('Pandem1c'));

    expect(await screen.findByText('AI Scouting Report')).toBeInTheDocument();
    expect(screen.getAllByText('The overview text').length).toBeGreaterThan(0);
  });

  it('clicking an open report again collapses it (accordion)', async () => {
    const user = userEvent.setup();
    reportsConfig.mockResolvedValue({ enabled: true });
    reportsList.mockResolvedValue([
      {
        id: 'r1',
        createdAt: 1_700_000_000_000,
        model: 'claude-opus-4-8',
        player: { id: 1802316, gamerTag: 'Pandem1c' },
        report: { ...REPORT_SHAPE, overview: 'The overview text' },
      },
    ]);

    renderPage();
    await user.click(await screen.findByText('Pandem1c'));
    expect(await screen.findByText('AI Scouting Report')).toBeInTheDocument();

    await user.click(screen.getByText('Pandem1c'));
    expect(screen.queryByText('AI Scouting Report')).not.toBeInTheDocument();
  });

  describe('legacy provenance badge (plan 39-10, RPT-10, UI-SPEC E2 zero-one-many)', () => {
    const VALIDATED_SHAPE = {
      ...REPORT_SHAPE,
      claimSchemaVersion: 1,
      validation: {
        status: 'passed',
        policyVersion: 1,
        snapshotId: 'snap-1',
        claimSchemaVersion: 1,
      },
    };

    /** One single-report group per tag; `legacy` picks which tags carry a pre-Phase-39 record. */
    function mixedList(tags: string[], legacy: Set<string>) {
      return tags.map((gamerTag, index) => ({
        id: `r-${gamerTag}`,
        createdAt: 1_700_000_000_000 + index * 1_000,
        model: 'claude-opus-4-8',
        player: { id: 1_000 + index, gamerTag },
        report: legacy.has(gamerTag) ? REPORT_SHAPE : VALIDATED_SHAPE,
      }));
    }

    /** Maps each rendered row (by gamer tag) to whether it carries a legacy badge. */
    function badgeByRow(tags: string[]): Record<string, boolean> {
      const out: Record<string, boolean> = {};
      for (const tag of tags) {
        const row = screen.getByText(tag).closest('.border-b');
        expect(row).not.toBeNull();
        out[tag] = row!.querySelector('[data-legacy-report-badge="row"]') !== null;
      }
      return out;
    }

    const TAGS = ['Alpha', 'Bravo', 'Charlie'];

    it.each([
      { label: 'zero legacy rows', legacy: [] as string[] },
      { label: 'one legacy row', legacy: ['Bravo'] },
      { label: 'many legacy rows', legacy: ['Alpha', 'Charlie'] },
    ])(
      '$label: the badge renders on exactly the legacy rows, per row, with no list-level banner',
      async ({ legacy }) => {
        reportsConfig.mockResolvedValue({ enabled: true });
        reportsList.mockResolvedValue(mixedList(TAGS, new Set(legacy)));

        const { container } = renderPage();
        await screen.findByText('Alpha');

        expect(badgeByRow(TAGS)).toEqual(
          Object.fromEntries(TAGS.map((tag) => [tag, legacy.includes(tag)])),
        );
        // Every badge in the page lives inside a row — none in the card header
        // or above the list.
        const allBadges = container.querySelectorAll('[data-legacy-report-badge]');
        expect(allBadges).toHaveLength(legacy.length);
        expect(screen.queryAllByText('Legacy')).toHaveLength(legacy.length);
      },
    );

    it('an older report inside an expanded group carries its own per-row badge', async () => {
      const user = userEvent.setup();
      reportsConfig.mockResolvedValue({ enabled: true });
      reportsList.mockResolvedValue([
        {
          id: 'newer',
          createdAt: 1_700_200_000_000,
          model: 'claude-opus-4-8',
          player: { id: 1802316, gamerTag: 'Pandem1c' },
          report: VALIDATED_SHAPE,
        },
        {
          id: 'older',
          createdAt: 1_700_000_000_000,
          model: 'claude-opus-4-8',
          player: { id: 1802316, gamerTag: 'Pandem1c' },
          report: REPORT_SHAPE,
        },
      ]);

      renderPage();
      await screen.findByText('Pandem1c');
      expect(screen.queryByText('Legacy')).not.toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Show older reports' }));
      const olderRow = screen.getByRole('button', { name: /Older report/ }).closest('li');
      expect(olderRow?.querySelector('[data-legacy-report-badge="row"]')).not.toBeNull();
      expect(screen.getAllByText('Legacy')).toHaveLength(1);
    });
  });
});
