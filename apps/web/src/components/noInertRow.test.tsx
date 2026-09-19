import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, waitFor, within, type RenderResult } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Match, TournamentEntry } from '@smash-tracker/shared';
import { buildSetTimeline } from '@smash-tracker/shared';
import { TooltipProvider } from '@/components/ui/tooltip';
import { AuthProvider } from '@/context/AuthContext';
import { AnalyticsFilterProvider } from '@/context/AnalyticsFilterContext';
import { resetAuthMock, setMockUser, makeMockUser } from '@/test/mockAuth';
import { SpriteList } from '@/data/sprites';

import {
  OpponentTable,
  type OpponentTableRow,
} from '@/pages/FighterAnalysis/components/OpponentTable';
import { MatchupStageGuide } from '@/pages/FighterAnalysis/components/MatchupStageGuide';
import { StageMastery } from '@/pages/FighterAnalysis/components/StageMastery';
import { MatchupMatrix } from '@/pages/Matchups/components/MatchupMatrix';
import { MatchupsContext, type MatchupsContextValue } from '@/pages/Matchups/MatchupsContext';
import { MatrixHeat } from '@/components/charts/MatrixHeat';
import { CharactersAndStages } from '@/pages/Tournaments/components/CharactersAndStages';
import { AdvisorRetrospective } from '@/pages/Tournaments/components/AdvisorRetrospective';
import { buildRetrospective } from '@/pages/Tournaments/lib/retrospective';
import { SessionsAndTilt } from '@/pages/Trends/components/SessionsAndTilt';
import { RecentEncounters } from '@/pages/Opponents/components/RecentEncounters';
import { ScoutCommonOpponentsCard } from '@/pages/Scout/components/ScoutCommonOpponentsCard';
import { OpponentList } from '@/pages/Opponents/components/OpponentList';
import { WhatTheyPlayTable } from '@/pages/Opponents/components/WhatTheyPlayTable';
import { ScoutingStagesCard } from '@/pages/Opponents/components/ScoutingStagesCard';
import { TournamentHistory } from '@/pages/Opponents/components/TournamentHistory';
import { FilteredMatchList } from '@/components/FilteredMatchList';
import { StageDetailPage } from '@/pages/Stages/StageDetailPage';
import { FullAnalysisSection } from '@/pages/Scout/components/FullAnalysisSection';
import { SetTimeline } from '@/pages/Tournaments/components/SetTimeline';
import userEvent from '@testing-library/user-event';

/**
 * Phase 38-07 Task 3 (D-14/M-06/L-02): the DRL-03 no-inert-row oracle — a
 * committed test naming, in ONE array, every analytics row surface the
 * roadmap's no-inert-row success criterion (SC-4) names AND every surface
 * this phase wires, rendering each with a fixture guaranteeing at least one
 * row AND the props that make its rows interactive, asserting every rendered
 * row is or contains a real anchor or button with a non-empty accessible
 * name. Copies the committed, named, hand-maintained array style and
 * anti-rot self-check from `chartKitBoundary.test.ts`.
 *
 * COVERAGE CLAIM (stated no broader than the array below): every row surface
 * named by the roadmap's no-inert-row success criterion, PLUS every other
 * row surface this phase wires — the opponents list, the shared filtered
 * match list, the hub's cross-tab matrix, the stage page's two tables, and
 * the three absorbed hub cards (authored as three entries, per this task's
 * own instruction, making SEVENTEEN entries total) — with the
 * RECORDED_OMISSIONS array below naming what is deliberately outside it.
 *
 * PROVEN FAILING (both directions, executed by hand during this task,
 * reverted before commit — see the plan's SUMMARY for the exact observed
 * transcript):
 *   1. Temporarily reverting the SessionsAndTilt drill-down wire-up (Task 2)
 *      turned "every non-exempt row is a link or a button" red, naming the
 *      "Sessions and tilt table" surface.
 *   2. Temporarily renaming one enumerated file path turned "every entry's
 *      file exists" red, naming the stale path.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

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

const listMatches = vi.fn().mockResolvedValue([]);
const listTournaments = vi.fn().mockResolvedValue([]);
const upsertMe = vi.fn().mockResolvedValue({ uid: 'test-uid', email: 'test@example.com' });
const getMe = vi.fn().mockResolvedValue({
  uid: 'test-uid',
  email: 'test@example.com',
  fighters: { primary: [], secondary: [] },
  coachingModeEnabled: false,
  onboardingIntent: null,
});
const listAliases = vi.fn().mockResolvedValue({});
const upsertAlias = vi.fn().mockResolvedValue({});
const removeAlias = vi.fn().mockResolvedValue(undefined);
const listNotes = vi.fn().mockResolvedValue({});
const upsertNote = vi.fn().mockResolvedValue({ updatedAt: 1 });
const removeNote = vi.fn().mockResolvedValue(undefined);
const removeMatch = vi.fn().mockResolvedValue(undefined);
const enrichmentAttribution = vi.fn().mockResolvedValue({ attributions: [] });

vi.mock('@/lib/api', () => ({
  api: {
    users: {
      upsertMe: (...args: unknown[]) => upsertMe(...args),
      getMe: (...args: unknown[]) => getMe(...args),
      enrichmentAttribution: (...args: unknown[]) => enrichmentAttribution(...args),
    },
    matches: {
      list: (...args: unknown[]) => listMatches(...args),
      remove: (...args: unknown[]) => removeMatch(...args),
    },
    tournaments: {
      list: (...args: unknown[]) => listTournaments(...args),
    },
    opponents: {
      aliases: {
        list: (...args: unknown[]) => listAliases(...args),
        upsert: (...args: unknown[]) => upsertAlias(...args),
        remove: (...args: unknown[]) => removeAlias(...args),
      },
      notes: {
        list: (...args: unknown[]) => listNotes(...args),
        upsert: (...args: unknown[]) => upsertNote(...args),
        remove: (...args: unknown[]) => removeNote(...args),
      },
    },
  },
}));

beforeEach(() => {
  resetAuthMock();
  setMockUser(makeMockUser());
});

const mario = SpriteList.find((s) => s.id === 1)!; // Mario
const luigi = SpriteList.find((s) => s.id === 10)!; // Luigi

function makeMatch(overrides: Partial<Match> & Pick<Match, 'id' | 'time' | 'win'>): Match {
  return {
    fighter_id: mario.id,
    opponent_id: luigi.id,
    map: { id: 1, name: 'Battlefield' },
    opponent: 'rival',
    notes: '',
    matchType: 'offline-tourney',
    ...overrides,
  };
}

function withRouter(ui: React.ReactElement, initialPath = '/') {
  return render(<MemoryRouter initialEntries={[initialPath]}>{ui}</MemoryRouter>);
}

function withRouterAndQuery(ui: React.ReactElement, initialPath = '/') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>
    </MemoryRouter>,
  );
}

/** `<tr>` data rows only — excludes every `<thead>` header row (which carries `<th>`, never `<td>`). Safe across a container with MULTIPLE tables (e.g. StageDetailPage's by-opponent AND by-character tables), where a naive `.slice(1)` would only drop the FIRST table's header. */
function dataRows(container: HTMLElement): HTMLElement[] {
  return within(container)
    .getAllByRole('row')
    .filter((row) => row.querySelector('td') != null);
}

/** Every rendered row that "is or contains" a link/button with a non-empty accessible name. */
function accessibleInteractiveDescendant(row: HTMLElement): HTMLElement | null {
  const candidates = [row, ...Array.from(row.querySelectorAll<HTMLElement>('a[href], button'))];
  return (
    candidates.find((el) => {
      const isInteractive = el.tagName === 'A' || el.tagName === 'BUTTON';
      if (!isInteractive) return false;
      const name = (el.getAttribute('aria-label') ?? el.textContent ?? '').trim();
      return name.length > 0;
    }) ?? null
  );
}

// ---------------------------------------------------------------------------
// Surface enumeration — SEVENTEEN entries (the three absorbed hub cards are
// authored separately, per this task's own instruction).
// ---------------------------------------------------------------------------

interface Surface {
  name: string;
  file: string;
  render: () => RenderResult;
  rows: (result: RenderResult) => HTMLElement[];
}

const SURFACES: Surface[] = [
  {
    name: 'Fighter Analysis opponent table',
    file: 'apps/web/src/pages/FighterAnalysis/components/OpponentTable.tsx',
    render: () => {
      const rows: OpponentTableRow[] = [
        { key: 'mkleo', displayLabel: 'mkleo', wins: 3, losses: 1, total: 4, winRate: 75 },
        // Unaddressable identity (D-14 exemption: unnamed-opponent bucket).
        { key: 'unknown', displayLabel: 'unknown', wins: 1, losses: 0, total: 1, winRate: 100 },
      ];
      return withRouter(
        <OpponentTable
          rows={rows}
          hubHref={(row) => (row.key === 'unknown' ? undefined : `/opponents/${row.key}`)}
        />,
      );
    },
    rows: (result) => dataRows(result.container),
  },
  {
    name: 'Matchup stage guide',
    file: 'apps/web/src/pages/FighterAnalysis/components/MatchupStageGuide.tsx',
    render: () => {
      const matches = Array.from({ length: 3 }, (_, i) =>
        makeMatch({ id: `g${i}`, time: i, win: true, fighter_id: mario.id, opponent_id: luigi.id }),
      );
      return withRouter(<MatchupStageGuide fighterMatches={matches} />);
    },
    rows: (result) => dataRows(result.container),
  },
  {
    name: 'Stage breakdown tile grid (StageMastery, own-subject host, stageHref supplied)',
    file: 'apps/web/src/pages/FighterAnalysis/components/StageMastery.tsx',
    render: () => {
      // A tile only renders once its stage clears the abstention floor
      // (rankStagesByEvidence gates by sample size) — three games required.
      const matches = Array.from({ length: 3 }, (_, i) =>
        makeMatch({ id: `g${i}`, time: i, win: true }),
      );
      return withRouter(
        <StageMastery fighterMatches={matches} stageHref={(id) => `/stages/${id}`} />,
      );
    },
    rows: (result) => Array.from(result.container.querySelectorAll('a')),
  },
  {
    name: 'Matchups matrix cells',
    file: 'apps/web/src/pages/Matchups/components/MatchupMatrix.tsx',
    render: () => {
      const matches = [makeMatch({ id: 'g1', time: 1, win: true })];
      const contextValue: MatchupsContextValue = {
        fighterSprites: [mario],
        fighter: mario,
        setFighter: vi.fn(),
        opponent: luigi,
        setOpponent: vi.fn(),
        fighterUsageById: new Map(),
        opponentUsage: [],
        drillDownAxes: {},
        setDrillDown: vi.fn(),
      };
      return withRouter(
        <MatchupsContext.Provider value={contextValue}>
          <MatchupMatrix matches={matches} />
        </MatchupsContext.Provider>,
      );
    },
    rows: (result) => within(result.container).getAllByRole('button'),
  },
  {
    name: "The hub's cross-tab matrix (MatrixHeat, as the hub configures it)",
    file: 'apps/web/src/components/charts/MatrixHeat.tsx',
    render: () =>
      render(
        <MatrixHeat
          rows={[{ key: '1:10', label: 'Mario vs Luigi' }]}
          cols={[{ key: '1', label: 'Battlefield' }]}
          cells={[
            {
              rowKey: '1:10',
              colKey: '1',
              wins: 3,
              losses: 1,
              total: 4,
              confidenceTier: 'low',
              sample: {
                rawSampleSize: 4,
                eligibleDenominator: 4,
                knownFieldCoverage: 1,
                dateRange: null,
                refreshedAt: 0,
                evidencePolicyVersion: 1,
                recencyTreatment: 'unweighted',
                confidenceTier: 'low',
              },
            },
          ]}
          onSelectCell={vi.fn()}
          emptyMessage="empty"
        />,
      ),
    rows: (result) => within(result.container).getAllByRole('button'),
  },
  {
    name: 'Tournament characters-and-stages card',
    file: 'apps/web/src/pages/Tournaments/components/CharactersAndStages.tsx',
    render: () => {
      const matches = [makeMatch({ id: 'g1', time: 1, win: true })];
      return withRouter(
        <CharactersAndStages matches={matches} eventKeyForStage={() => 'genesis-9'} />,
      );
    },
    rows: (result) => within(result.container).getAllByRole('link'),
  },
  {
    name: 'Advisor retrospective',
    file: 'apps/web/src/pages/Tournaments/components/AdvisorRetrospective.tsx',
    render: () => {
      const pre = Array.from({ length: 5 }, (_, i) =>
        makeMatch({ id: `p${i}`, time: 100 + i, win: true, map: { id: 1, name: 'Battlefield' } }),
      );
      const entry: TournamentEntry = {
        eventId: 1,
        eventName: 'Ultimate Singles',
        firstSetAt: 1_000_000,
        lastSetAt: 2_000_000,
        setsPlayed: 1,
      };
      const game = makeMatch({
        id: 'g1',
        time: 1_500_000,
        win: true,
        map: { id: 1, name: 'Battlefield' },
        externalId: 'sgg:1:g1',
      });
      const retrospective = buildRetrospective([...pre, game], [game], entry);
      return withRouter(
        <TooltipProvider>
          <AdvisorRetrospective
            retrospective={retrospective}
            eventKeyForStage={() => 'genesis-9'}
          />
        </TooltipProvider>,
      );
    },
    rows: (result) => within(result.container).getAllByRole('link'),
  },
  {
    name: 'Sessions-and-tilt table',
    file: 'apps/web/src/pages/Trends/components/SessionsAndTilt.tsx',
    render: () => {
      const matches = [makeMatch({ id: 'g1', time: 1, win: true })];
      return withRouterAndQuery(<SessionsAndTilt matches={matches} />);
    },
    rows: (result) => dataRows(result.container),
  },
  {
    name: 'Recent encounters',
    file: 'apps/web/src/pages/Opponents/components/RecentEncounters.tsx',
    render: () => {
      const matches = [makeMatch({ id: 'g1', time: 1, win: true, vodUrl: 'https://x.test/v' })];
      return withRouter(<RecentEncounters matches={matches} />);
    },
    rows: (result) => within(result.container).getAllByRole('listitem'),
  },
  {
    name: 'The scouting common-opponents card',
    file: 'apps/web/src/pages/Scout/components/ScoutCommonOpponentsCard.tsx',
    render: () =>
      withRouter(<ScoutCommonOpponentsCard opponents={[{ gamerTag: 'rival', sets: 3 }]} />),
    rows: (result) => within(result.container).getAllByRole('listitem'),
  },
  {
    name: 'The opponents list rows',
    file: 'apps/web/src/pages/Opponents/components/OpponentList.tsx',
    render: () => {
      const matches: Match[] = [
        makeMatch({ id: 'a1', time: 1, win: true, opponent: 'alice' }),
        makeMatch({ id: 'a2', time: 2, win: true, opponent: 'alice' }),
      ];
      return withRouter(
        <OpponentList
          matches={matches}
          selected={null}
          onSelect={vi.fn()}
          onRequestMerge={vi.fn()}
          aliasMap={{}}
          hubHref={(row) => `/opponents/${row.displayTag}`}
        />,
      );
    },
    rows: (result) => within(result.container).getAllByRole('listitem'),
  },
  {
    name: "The tournament set timeline's set rows",
    file: 'apps/web/src/pages/Tournaments/components/SetTimeline.tsx',
    render: () => {
      const matches = [makeMatch({ id: 'g1', time: 100, win: true, externalId: 'sgg:1:g1' })];
      const { sets, otherMatches } = buildSetTimeline(matches);
      const entry: TournamentEntry = {
        eventId: 1,
        eventName: 'Ultimate Singles',
        firstSetAt: 100,
        lastSetAt: 100,
        setsPlayed: 1,
      };
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      return render(
        <MemoryRouter>
          <QueryClientProvider client={queryClient}>
            <AuthProvider>
              <TooltipProvider>
                <SetTimeline entry={entry} sets={sets} otherMatches={otherMatches} />
              </TooltipProvider>
            </AuthProvider>
          </QueryClientProvider>
        </MemoryRouter>,
      );
    },
    rows: (result) => within(result.container).getAllByRole('listitem'),
  },
  {
    name: "The shared filtered match list's rows (the terminus)",
    file: 'apps/web/src/components/FilteredMatchList.tsx',
    render: () => {
      const matches = [makeMatch({ id: 'g1', time: 1, win: true })];
      return withRouterAndQuery(<FilteredMatchList matches={matches} axes={{}} />);
    },
    rows: (result) => dataRows(result.container),
  },
  {
    name: "The stage detail page's by-opponent and by-character tables",
    file: 'apps/web/src/pages/Stages/StageDetailPage.tsx',
    render: () => {
      listMatches.mockResolvedValue([
        makeMatch({ id: 'g1', time: 1, win: true }),
        makeMatch({ id: 'g2', time: 2, win: true }),
      ]);
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      return render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={['/stages/1']}>
            <AuthProvider>
              <AnalyticsFilterProvider>
                <Routes>
                  <Route path="/stages/:stageId" element={<StageDetailPage />} />
                </Routes>
              </AnalyticsFilterProvider>
            </AuthProvider>
          </MemoryRouter>
        </QueryClientProvider>,
      );
    },
    rows: (result) => dataRows(result.container),
  },
  {
    name: 'Absorbed hub card: what-they-play',
    file: 'apps/web/src/pages/Opponents/components/WhatTheyPlayTable.tsx',
    render: () =>
      withRouter(
        <WhatTheyPlayTable
          byTheirFighter={
            [
              { opponentFighterId: 41, wins: 3, losses: 1, ratio: 75, totalMatches: 4 },
              // Unmapped fighter id (D-14 exemption: unknown character).
              { opponentFighterId: 999_999, wins: 1, losses: 0, ratio: 100, totalMatches: 1 },
            ] as never
          }
          rowHref={(row) =>
            `/matchups?vs=${(row as { opponentFighterId: number }).opponentFighterId}`
          }
        />,
      ),
    rows: (result) => dataRows(result.container),
  },
  {
    name: 'Absorbed hub card: scouting stages',
    file: 'apps/web/src/pages/Opponents/components/ScoutingStagesCard.tsx',
    render: () =>
      withRouter(
        <ScoutingStagesCard
          byStage={[
            { stageId: 1, wins: 3, losses: 1, total: 4, winRate: 75 },
            // Unknown stage sentinel (D-14 exemption: unknown stage).
            { stageId: 0, wins: 1, losses: 0, total: 1, winRate: 100 },
          ]}
          stageHref={(id) => `/stages/${id}`}
        />,
      ),
    rows: (result) => dataRows(result.container),
  },
  {
    name: 'Absorbed hub card: tournament-history set rows',
    file: 'apps/web/src/pages/Opponents/components/TournamentHistory.tsx',
    render: () => {
      const block = {
        displayName: 'The Big House 9',
        eventName: 'The Big House 9',
        sets: [
          {
            setId: '1',
            games: [
              {
                match: makeMatch({ id: 'g1', time: 100, win: true }),
                stageAbbr: 'BF',
                stageName: 'Battlefield',
                win: true,
              },
            ],
            wins: 1,
            losses: 0,
            roundLabel: 'Winners Semi-Final',
            isLosersSide: false,
            time: 100,
          },
        ],
        startTime: 100,
        endTime: 100,
        wins: 1,
        losses: 0,
      };
      return withRouter(
        <TournamentHistory blocks={[block]} tournamentEntries={[]} onSelectEvent={vi.fn()} />,
      );
    },
    rows: (result) => within(result.container).getAllByRole('listitem'),
  },
];

// ---------------------------------------------------------------------------
// Third-party-data hosts — INVERSE expectation (H-02/C2-H-01): zero rendered
// anchors matching ANY destination this phase's builders produce (hub,
// stage detail, param-aware Matchups, video route) — never scoped to only
// hub-or-stage, which the what-they-play retrofit's Matchups destination
// would silently pass.
// ---------------------------------------------------------------------------

const PHASE_DESTINATION_PATTERN = /^\/(opponents\/|stages\/|matchups\?|vod\?match=)/;

interface ThirdPartyHost {
  name: string;
  file: string;
  render: () => RenderResult;
}

const THIRD_PARTY_HOSTS: ThirdPartyHost[] = [
  {
    name: "Scout's FullAnalysisSection — renders StageMastery x2, OpponentTable and WhatTheyPlayTable over a SCOUTED PLAYER's history",
    file: 'apps/web/src/pages/Scout/components/FullAnalysisSection.tsx',
    render: () => {
      const games = [
        {
          time: 1,
          win: true,
          fighterId: 1,
          opponentFighterId: 41,
          stageId: 1,
          stageName: 'Battlefield',
          opponentTag: 'PowPow',
        },
        {
          time: 2,
          win: false,
          fighterId: 1,
          opponentFighterId: 41,
          stageId: 1,
          stageName: 'Battlefield',
          opponentTag: 'PowPow',
        },
        {
          time: 3,
          win: true,
          fighterId: 1,
          opponentFighterId: 41,
          stageId: 1,
          stageName: 'Battlefield',
          opponentTag: 'PowPow',
        },
        // A minority second character — triggers the SECOND (top-character) StageMastery card.
        {
          time: 4,
          win: true,
          fighterId: 2,
          opponentFighterId: 41,
          stageId: 1,
          stageName: 'Battlefield',
          opponentTag: 'PowPow',
        },
      ];
      return render(<FullAnalysisSection games={games as never} gamerTag="Pandem1c" />);
    },
  },
];

// ---------------------------------------------------------------------------
// Per-row exemptions — the ONLY permitted reasons (UI-SPEC E6/partial).
// ---------------------------------------------------------------------------

interface RowExemption {
  surface: string;
  reason: 'unnamed-opponent bucket' | 'unknown stage' | 'unknown character';
  predicate: (row: HTMLElement) => boolean;
}

const ROW_EXEMPTIONS: RowExemption[] = [
  {
    surface: 'Fighter Analysis opponent table',
    reason: 'unnamed-opponent bucket',
    predicate: (row) => row.textContent?.includes('unknown') === true,
  },
  {
    surface: 'Absorbed hub card: scouting stages',
    reason: 'unknown stage',
    predicate: (row) => row.textContent?.includes('unknown') === true,
  },
  {
    surface: 'Absorbed hub card: what-they-play',
    reason: 'unknown character',
    predicate: (row) => row.textContent?.includes('Unknown') === true,
  },
];

// ---------------------------------------------------------------------------
// Recorded omissions — surfaces deliberately outside the enumeration above,
// named with a reason so the coverage claim stays auditable.
// ---------------------------------------------------------------------------

const RECORDED_OMISSIONS: { file: string; reason: string }[] = [
  {
    file: 'apps/web/src/pages/Opponents/components/TendenciesCard.tsx',
    reason:
      'A notes editor (habits, watch-fors, banned stages, edit-in-place) with no analytics rows and no drill target — D-12 lists it among the absorbed cards, but it is not a row surface.',
  },
];

/**
 * Renders a surface and waits for its row-producing data to settle (several
 * surfaces — StageDetailPage foremost — read TanStack Query hooks that
 * resolve asynchronously even against a resolved mock) before returning.
 * Every assertion below reads through this helper so none of them races the
 * initial "Loading…" render.
 */
async function renderReady(surface: Surface): Promise<RenderResult> {
  const result = surface.render();
  await waitFor(() => expect(surface.rows(result).length).toBeGreaterThan(0));
  return result;
}

describe('DRL-03 no-inert-row oracle', () => {
  it('every enumerated file exists (surfaces, third-party hosts, and recorded omissions alike)', () => {
    const allPaths = [
      ...SURFACES.map((s) => s.file),
      ...THIRD_PARTY_HOSTS.map((h) => h.file),
      ...RECORDED_OMISSIONS.map((o) => o.file),
    ];
    const missing = allPaths.filter((p) => !fs.existsSync(path.join(REPO_ROOT, p)));
    expect(missing, `stale enumeration entries (file missing): ${missing.join(', ')}`).toEqual([]);
  });

  it('the surface enumeration has the stated SEVENTEEN entries', () => {
    expect(SURFACES.length).toBe(17);
  });

  it('every surface renders at least one row for its fixture (never passes vacuously)', async () => {
    for (const surface of SURFACES) {
      const result = await renderReady(surface);
      result.unmount();
    }
  });

  it('every rendered row that is not matched by an exemption predicate is, or contains, a real anchor/button with a non-empty accessible name', async () => {
    for (const surface of SURFACES) {
      const result = await renderReady(surface);
      const rows = surface.rows(result);
      const exemptions = ROW_EXEMPTIONS.filter((e) => e.surface === surface.name);
      for (const row of rows) {
        const isExempt = exemptions.some((e) => e.predicate(row));
        if (isExempt) continue;
        const interactive = accessibleInteractiveDescendant(row);
        expect(
          interactive,
          `${surface.name}: a non-exempt row has no accessible link/button — "${row.textContent}"`,
        ).not.toBeNull();
      }
      result.unmount();
    }
  });

  it("every per-row exemption predicate matches at least one row in its surface's fixture", async () => {
    for (const exemption of ROW_EXEMPTIONS) {
      const surface = SURFACES.find((s) => s.name === exemption.surface)!;
      const result = await renderReady(surface);
      const rows = surface.rows(result);
      const matched = rows.some((row) => exemption.predicate(row));
      expect(matched, `exemption "${exemption.reason}" on ${surface.name} never fired`).toBe(true);
      result.unmount();
    }
  });

  it("every third-party-data host renders ZERO anchors matching any destination this phase's builders produce", async () => {
    const user = userEvent.setup();
    for (const host of THIRD_PARTY_HOSTS) {
      const result = host.render();
      // Expand the collapsible section so its content (and any anchors) mount.
      await user.click(within(result.container).getByRole('button', { name: /full analysis/i }));
      const anchors = Array.from(result.container.querySelectorAll<HTMLAnchorElement>('a[href]'));
      const offenders = anchors.filter((a) =>
        PHASE_DESTINATION_PATTERN.test(a.getAttribute('href') ?? ''),
      );
      expect(
        offenders.map((a) => a.getAttribute('href')),
        `${host.name} rendered a destination anchor into the viewer's own routes`,
      ).toEqual([]);
      result.unmount();
    }
  });

  it("the recorded-omissions array's reasoning holds: TendenciesCard has no analytics rows", () => {
    // Read-only confirmation (not a render) — its own component test coverage
    // lives in OpponentsPage.test.tsx/OpponentHubPage.test.tsx; this asserts
    // only that the omitted file's content matches the recorded reason.
    const filePath = path.join(REPO_ROOT, RECORDED_OMISSIONS[0]!.file);
    const source = fs.readFileSync(filePath, 'utf8');
    expect(source).toMatch(/notes editor|habits|watchFor/i);
  });
});
