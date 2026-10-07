import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, waitFor, within, type RenderResult } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Match, TournamentEntry } from '@smash-tracker/shared';
import {
  buildSetTimeline,
  buildTierSplitStats,
  resolveTournamentTier,
  ROSTER_MAIN_MIN_GAMES,
  ROSTER_SECONDARY_MIN_GAMES,
} from '@smash-tracker/shared';
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
import { ScoutRecentEventsCard } from '@/pages/Scout/components/ScoutRecentEventsCard';
import { OpponentList } from '@/pages/Opponents/components/OpponentList';
import { WhatTheyPlayTable } from '@/pages/Opponents/components/WhatTheyPlayTable';
import { ScoutingStagesCard } from '@/pages/Opponents/components/ScoutingStagesCard';
import { TournamentHistory } from '@/pages/Opponents/components/TournamentHistory';
import { FilteredMatchList, FILTERED_MATCH_LIST_ROW_CAP } from '@/components/FilteredMatchList';
import { StageDetailPage } from '@/pages/Stages/StageDetailPage';
import { FullAnalysisSection } from '@/pages/Scout/components/FullAnalysisSection';
import { SetTimeline } from '@/pages/Tournaments/components/SetTimeline';
import {
  TournamentsTable,
  type TournamentTableRow,
} from '@/pages/Tournaments/components/TournamentsTable';
import { ByTierCard } from '@/components/analytics/tier/ByTierCard';
import { TrackedRow } from '@/components/analytics/track/TrackedRow';
import { DigestCard } from '@/components/analytics/track/DigestCard';
import type { UseDigestResult } from '@/hooks/useDigest';
import { buildTrackedRows } from '@/components/analytics/track/trackedRowModel';
import i18n from '@/i18n';
import { PairingOpponents } from '@/pages/Matchups/components/PairingOpponents';
import { MatchupStageTable } from '@/pages/Matchups/components/MatchupStageTable';
import { MatchupInsights } from '@/pages/Matchups/components/MatchupInsights';
import { RosterUsage } from '@/pages/MatchData/components/RosterUsage';
import { StageBreakdown } from '@/pages/MatchData/components/StageBreakdown';
import { VsCharactersList } from '@/pages/FighterAnalysis/components/VsCharactersList';
import { VsPlayersList } from '@/pages/FighterAnalysis/components/VsPlayersList';
import { SettingComparison } from '@/pages/Trends/components/SettingComparison';
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
 * match list (both its table and its narrow-layout stack, phase 38-08), the
 * hub's cross-tab matrix, the stage page's two tables, and the three
 * absorbed hub cards (authored as three entries, per this task's own
 * instruction, making EIGHTEEN entries total) — with the RECORDED_OMISSIONS
 * array below naming what is deliberately outside it.
 *
 * Plan 39.1-21 Task 2 appends SEVEN more entries (18 -> 25) for this phase's
 * own new row surfaces (named in the plan SUMMARYs of 39.1-13/14/15/16/18):
 * the Matchups by-opponent list (`PairingOpponents.tsx`), the Match Data
 * roster rows (`RosterUsage.tsx`), the Match Data stage rows
 * (`StageBreakdown.tsx`), the Fighter Analysis dumbbell lists
 * (`VsCharactersList.tsx`/`VsPlayersList.tsx`), the Trends setting-comparison
 * dumbbell rows (`SettingComparison.tsx`), and the Recent Encounters
 * event-set rows (`RecentEncounters.tsx`'s `SetRow`, the event-grouped
 * variant — the file's own EXISTING "Recent encounters" entry above already
 * covers the session-pseudo-set variant on a single-match fixture, so this
 * new entry is named distinctly rather than duplicating that coverage). The
 * array is EXTENDED in place — no second enumeration file, per this task's
 * own instruction never to fork it.
 *
 * Plan 39.1-23 (UIX-02, gap closure) appends ONE more entry (25 -> 26): the
 * terminus's row-cap Show-all expanded tail, proving no-inert-row holds past
 * `FILTERED_MATCH_LIST_ROW_CAP`, not just in the capped head every other
 * FilteredMatchList entry above exercises.
 *
 * Plan 39.2-07 (TIER-02, UI-SPEC §13 G6) appends TWO more entries (30 -> 32):
 * the tier-aware Tournaments table (`TournamentsTable.tsx`) in both its table
 * root and its stacked phone root.
 *
 * Plan 39.2-08 (TIER-03, UI-SPEC §13 G6) appends ONE more entry (32 -> 33):
 * the By-tier card (`ByTierCard.tsx`), whose rows include the Unknown row in
 * its inset — every tier row and the Unknown row is a filter door.
 *
 * Plan 39.2-11 (TRK-02, UI-SPEC §13 G6) appends TWO more entries (33 -> 35):
 * the Dashboard's Tracked rows (`TrackedRow.tsx`), full and compact, one row of
 * each kind (opponent, matchup, stage).
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
    // Plan 39.2-10: every Track host reads the subject's watchlist.
    watchlist: {
      list: vi.fn().mockResolvedValue({ items: [] }),
      track: vi.fn(),
      untrack: vi.fn(),
    },
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
// Surface enumeration — EIGHTEEN entries (the three absorbed hub cards are
// authored separately, per this task's own instruction; phase 38-08 adds a
// second entry for the shared filtered match list's narrow/stacked layout).
// ---------------------------------------------------------------------------

/**
 * Plan 39.2-11: one tracked item of each kind (opponent, matchup, stage) over
 * a small history, built through the same `buildTrackedRows` the Dashboard's
 * section uses, so the enumerated rows are the real rows.
 */
function trackedRowModelsFixture(
  moved?: ReadonlyMap<string, { token: 'up' | 'down' | 'unlocked'; salience: number }>,
) {
  const day = 24 * 60 * 60 * 1000;
  const now = Date.now();
  const matches = Array.from({ length: 6 }, (_, i) =>
    makeMatch({ id: `tr-${i}`, time: now - (6 - i) * day, win: i % 2 === 0, opponent: 'rival' }),
  );
  const entries = [
    { itemKey: 'opponent:rival', item: { kind: 'opponent' as const, ref: 'rival', createdAt: 1 } },
    {
      itemKey: `matchup:${mario.id}-${luigi.id}`,
      item: {
        kind: 'matchup' as const,
        ref: { fighterId: mario.id, vsFighterId: luigi.id },
        createdAt: 2,
      },
    },
    { itemKey: 'stage:1', item: { kind: 'stage' as const, ref: 1, createdAt: 3 } },
  ];
  return buildTrackedRows({
    entries,
    matches,
    aliasMap: {},
    horizon: 'last30',
    nowMs: now,
    t: i18n.t.bind(i18n),
    moved,
  });
}

/** Plan 39.2-12: the digest as the Dashboard mounts it — expanded, with the three fixture items all moved. */
function expandedDigestFixture(): UseDigestResult {
  const movedRows = trackedRowModelsFixture(
    new Map([
      ['opponent:rival', { token: 'down' as const, salience: 3 }],
      [`matchup:${mario.id}-${luigi.id}`, { token: 'up' as const, salience: 2 }],
      ['stage:1', { token: 'unlocked' as const, salience: 1 }],
    ]),
  );
  return {
    status: 'expanded',
    newGames: 41,
    newEvents: 2,
    movedCount: movedRows.length,
    movedRows,
    moreCount: 2,
    movedByItemKey: new Map(),
    since: Date.now(),
    visitLastSeenAt: null,
    visitSeenEvents: null,
    snapshotReady: true,
    canMarkAsRead: true,
    markAsRead: () => undefined,
  };
}

interface Surface {
  name: string;
  file: string;
  render: () => RenderResult;
  rows: (result: RenderResult) => HTMLElement[];
}

/** Plan 39.2-07: three Tournaments rows — dated, imported with no games, and undated. */
function tournamentTableFixtureRows(): TournamentTableRow[] {
  const entries = [
    {
      eventId: 1,
      entryKey: '1',
      eventName: 'Ultimate Singles',
      tournamentName: 'Supernova 2026',
      firstSetAt: Date.UTC(2026, 7, 8),
      lastSetAt: Date.UTC(2026, 7, 9),
      setsPlayed: 5,
      numEntrants: 2048,
      placement: 3,
      seed: 8,
      isOnline: false,
    },
    {
      eventId: 2,
      entryKey: '2',
      eventName: 'Ultimate Singles',
      tournamentName: 'The Big House 9',
      firstSetAt: Date.UTC(2024, 5, 10),
      lastSetAt: Date.UTC(2024, 5, 10),
      setsPlayed: 5,
      origin: 'admin-imported',
      provider: 'startgg',
    },
    {
      eventId: 3,
      entryKey: '3',
      eventName: 'Squad Strike',
      tournamentName: 'Undated Open',
      firstSetAt: 0,
      lastSetAt: 0,
      setsPlayed: 0,
    },
  ] as unknown as TournamentEntry[];
  return entries.map((entry) => ({
    entry,
    record: { wins: 0, losses: 0, total: 0, winRate: 0 } as TournamentTableRow['record'],
    resolution: resolveTournamentTier({ entry, observedOnline: false }),
  }));
}

/**
 * Plan 39.2-08: a By-tier split with two ordinary tier rows, one tier row
 * that abstains (a row must be a door even with no bar) and the Unknown row.
 */
function byTierFixtureStats() {
  const day = 24 * 60 * 60 * 1000;
  const base = Date.UTC(2026, 0, 1);
  const entryAt = (index: number, overrides: Record<string, unknown>) => ({
    entryKey: `by-tier-${index}`,
    eventName: `Fixture Event ${index}`,
    tournamentName: `Fixture Tournament ${index}`,
    firstSetAt: base + index * 30 * day,
    lastSetAt: base + index * 30 * day + day / 2,
    isOnline: false,
    ...overrides,
  });
  const entries = [
    entryAt(1, { numEntrants: 2048 }),
    entryAt(2, { numEntrants: 20 }),
    entryAt(3, { numEntrants: 300 }),
    entryAt(4, { isOnline: true, numEntrants: 40 }),
  ];
  const matches: Match[] = entries.flatMap((entry, index) =>
    Array.from({ length: index === 2 ? 1 : 5 }, (_, g) =>
      makeMatch({
        id: `by-tier-${index}-${g}`,
        time: entry.firstSetAt + g * 1000,
        win: g % 2 === 0,
        eventName: entry.eventName,
        tournamentName: entry.tournamentName,
        matchType: entry.isOnline ? 'online-tourney' : 'offline-tourney',
      }),
    ),
  );
  return buildTierSplitStats({ entries, matches, includeSideEvents: false });
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
  // Plan 39.1-49 (UI-SPEC §6.6): the stacked phone layouts of the converted
  // tables, each rendered with `layout="stack"` (FilteredMatchList's
  // precedent) — every stacked row keeps its table row's link.
  {
    name: 'Fighter Analysis opponent table, stacked (below 640px)',
    file: 'apps/web/src/pages/FighterAnalysis/components/OpponentTable.tsx',
    render: () => {
      const rows: OpponentTableRow[] = [
        { key: 'mkleo', displayLabel: 'mkleo', wins: 3, losses: 1, total: 4, winRate: 75 },
        { key: 'unknown', displayLabel: 'unknown', wins: 1, losses: 0, total: 1, winRate: 100 },
      ];
      return withRouter(
        <OpponentTable
          rows={rows}
          hubHref={(row) => (row.key === 'unknown' ? undefined : `/opponents/${row.key}`)}
          layout="stack"
        />,
      );
    },
    rows: (result) =>
      Array.from(
        result.container.querySelectorAll<HTMLElement>('ul[data-slot="opponent-table"] > li'),
      ),
  },
  {
    name: 'Matchup stage guide, stacked (below 640px)',
    file: 'apps/web/src/pages/FighterAnalysis/components/MatchupStageGuide.tsx',
    render: () => {
      const matches = Array.from({ length: 3 }, (_, i) =>
        makeMatch({ id: `g${i}`, time: i, win: true, fighter_id: mario.id, opponent_id: luigi.id }),
      );
      return withRouter(<MatchupStageGuide fighterMatches={matches} layout="stack" />);
    },
    rows: (result) =>
      Array.from(result.container.querySelectorAll<HTMLElement>('li[data-slot="stage-guide-row"]')),
  },
  {
    name: 'Absorbed hub card: what-they-play, stacked (below 640px)',
    file: 'apps/web/src/pages/Opponents/components/WhatTheyPlayTable.tsx',
    render: () =>
      withRouter(
        <WhatTheyPlayTable
          byTheirFighter={
            [
              { opponentFighterId: 41, wins: 3, losses: 1, ratio: 75, totalMatches: 4 },
              { opponentFighterId: 999_999, wins: 1, losses: 0, ratio: 100, totalMatches: 1 },
            ] as never
          }
          rowHref={(row) =>
            `/matchups?vs=${(row as { opponentFighterId: number }).opponentFighterId}`
          }
          layout="stack"
        />,
      ),
    rows: (result) =>
      Array.from(
        result.container.querySelectorAll<HTMLElement>('ul[data-slot="what-they-play"] > li'),
      ),
  },
  {
    name: "Scout's recent events, stacked (below 640px)",
    file: 'apps/web/src/pages/Scout/components/ScoutRecentEventsCard.tsx',
    render: () =>
      render(
        <ScoutRecentEventsCard
          events={[
            {
              eventName: 'Ultimate Singles',
              placement: 3,
              numEntrants: 64,
              lastSetAt: 1_700_000_000_000,
              slug: 'tournament/the-big-house-9/event/ultimate-singles',
              source: 'startgg',
            },
          ]}
          layout="stack"
        />,
      ),
    rows: (result) =>
      Array.from(
        result.container.querySelectorAll<HTMLElement>('ul[data-slot="scout-recent-events"] > li'),
      ),
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
    // Plan 39.1-46 (sketch 003 A `stageCard`, PD-46-3): every Stage breakdown
    // series row is a text-only stage drill (a button), including the
    // sub-floor (under 3 games) row.
    name: 'Matchups stage breakdown rows (MatchupStageTable)',
    file: 'apps/web/src/pages/Matchups/components/MatchupStageTable.tsx',
    render: () => {
      const matches = [
        makeMatch({ id: 'sb1', time: 1, win: true, map: { id: 1, name: 'Battlefield' } }),
        makeMatch({ id: 'sb2', time: 2, win: true, map: { id: 1, name: 'Battlefield' } }),
        makeMatch({ id: 'sb3', time: 3, win: false, map: { id: 1, name: 'Battlefield' } }),
        makeMatch({ id: 'sb4', time: 4, win: false, map: { id: 83, name: 'Smashville' } }),
      ];
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
          <MatchupStageTable matchupMatches={matches} />
        </MatchupsContext.Provider>,
      );
    },
    rows: (result) =>
      Array.from(result.container.querySelectorAll('[data-slot="comparison-bars-series"] > li')),
  },
  {
    // Plan 39.1-46 (sketch 003 A `insightsCard`): the Insights card's Best /
    // Worst stage rows are stage drills (buttons) on the same series idiom.
    name: 'Matchups insights best / worst stage rows (MatchupInsights)',
    file: 'apps/web/src/pages/Matchups/components/MatchupInsights.tsx',
    render: () => {
      const stage = (id: number, name: string) => ({ id, name });
      const matches = [
        ...[true, true, true].map((win, i) =>
          makeMatch({ id: `bi${i}`, time: i, win, map: stage(1, 'Battlefield') }),
        ),
        ...[false, false, true].map((win, i) =>
          makeMatch({ id: `wi${i}`, time: 10 + i, win, map: stage(83, 'Smashville') }),
        ),
      ];
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
          <MatchupInsights matchupMatches={matches} />
        </MatchupsContext.Provider>,
      );
    },
    rows: (result) =>
      Array.from(result.container.querySelectorAll('[data-slot="comparison-bars-series"] > li')),
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
        <CharactersAndStages
          matches={matches}
          stageAggregateLinkParams={() => ({ eventKey: 'genesis-9' })}
        />,
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
    // Plan 39.1-15 (Task 2, UIX-04): rebuilt off the `Table` idiom onto the
    // `BoundedList` primitive (a plain `<ul><li>` list, not a table) — the
    // row selector below follows suit (mirrors "Recent encounters"'s own
    // `listitem` selector immediately below).
    name: 'Sessions-and-tilt list',
    file: 'apps/web/src/pages/Trends/components/SessionsAndTilt.tsx',
    render: () => {
      const matches = [makeMatch({ id: 'g1', time: 1, win: true })];
      return withRouterAndQuery(<SessionsAndTilt matches={matches} />);
    },
    rows: (result) => within(result.container).getAllByRole('listitem'),
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
    name: "The shared filtered match list's rows, narrow layout (the terminus, stacked)",
    file: 'apps/web/src/components/FilteredMatchList.tsx',
    render: () => {
      const matches = [makeMatch({ id: 'g1', time: 1, win: true })];
      return withRouterAndQuery(<FilteredMatchList matches={matches} axes={{}} layout="stack" />);
    },
    rows: (result) => within(result.container).getAllByRole('listitem'),
  },
  {
    // Plan 39.1-23 (UIX-02), replaced by plan 39.1-28's paging mechanism: a
    // narrowing over FILTERED_MATCH_LIST_ROW_CAP caps what mounts on first
    // render; this entry proves the no-inert-row contract holds in the
    // EXPANDED tail too, not just the capped head — activating the "Show N
    // more" paging control (synchronous fireEvents, so `render()` stays
    // synchronous like every other entry's) until it disappears mounts every
    // remaining row before this file's shared row-interactivity check runs
    // against them.
    name: "The shared filtered match list's rows, over-cap paging expansion (the terminus)",
    file: 'apps/web/src/components/FilteredMatchList.tsx',
    render: () => {
      const matches = Array.from({ length: FILTERED_MATCH_LIST_ROW_CAP + 5 }, (_, i) =>
        makeMatch({ id: `cap-${i}`, time: i, win: true }),
      );
      const result = withRouterAndQuery(<FilteredMatchList matches={matches} axes={{}} />);
      // WR-05 (39.1-REVIEW): `getByRole` first, so a renamed paging label
      // fails loudly instead of skipping the loop, and the row count after
      // the loop proves the whole tail mounted — otherwise the shared checks
      // would silently run against only the 100-row head.
      let button: HTMLElement | null = within(result.container).getByRole('button', {
        name: /show \d+ more/i,
      });
      while (button) {
        fireEvent.click(button);
        button = within(result.container).queryByRole('button', { name: /show \d+ more/i });
      }
      expect(dataRows(result.container)).toHaveLength(FILTERED_MATCH_LIST_ROW_CAP + 5);
      return result;
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
  // -------------------------------------------------------------------------
  // Plan 39.1-21 Task 2 additions — this phase's own new row surfaces
  // (see the module doc comment's "COVERAGE CLAIM" addendum above).
  // -------------------------------------------------------------------------
  {
    name: 'Matchups by-opponent list (PairingOpponents)',
    file: 'apps/web/src/pages/Matchups/components/PairingOpponents.tsx',
    render: () => {
      const matches = [
        makeMatch({ id: 'p1', time: 1, win: true, opponent: 'foxplayer' }),
        makeMatch({ id: 'p2', time: 2, win: true, opponent: 'foxplayer' }),
        makeMatch({ id: 'p3', time: 3, win: false, opponent: 'marthplayer' }),
      ];
      return withRouter(<PairingOpponents matchupMatches={matches} />);
    },
    rows: (result) => within(result.container).getAllByRole('listitem'),
  },
  {
    name: 'Match Data roster rows (RosterUsage)',
    file: 'apps/web/src/pages/MatchData/components/RosterUsage.tsx',
    render: () => {
      const [main, secondary] = SpriteList;
      const matches = [
        ...Array.from({ length: ROSTER_MAIN_MIN_GAMES + 5 }, (_, i) =>
          makeMatch({ id: `main${i}`, time: i, win: true, fighter_id: main!.id }),
        ),
        ...Array.from({ length: ROSTER_SECONDARY_MIN_GAMES + 5 }, (_, i) =>
          makeMatch({ id: `sec${i}`, time: 1000 + i, win: true, fighter_id: secondary!.id }),
        ),
      ];
      return withRouter(<RosterUsage matches={matches} />);
    },
    rows: (result) => Array.from(result.container.querySelectorAll('[data-slot="roster-row"]')),
  },
  {
    name: 'Match Data stage rows (StageBreakdown)',
    file: 'apps/web/src/pages/MatchData/components/StageBreakdown.tsx',
    render: () => {
      const matches = [
        makeMatch({ id: 'st1', time: 1, win: true, map: { id: 1, name: 'Battlefield' } }),
        makeMatch({ id: 'st2', time: 2, win: false, map: { id: 83, name: 'Smashville' } }),
      ];
      return withRouter(<StageBreakdown matches={matches} />);
    },
    rows: (result) => within(result.container).getAllByRole('listitem'),
  },
  {
    name: 'Fighter Analysis vs-characters dumbbell list (VsCharactersList)',
    file: 'apps/web/src/pages/FighterAnalysis/components/VsCharactersList.tsx',
    render: () => {
      const matches = [
        makeMatch({ id: 'vc1', time: 1, win: true, opponent_id: luigi.id }),
        makeMatch({ id: 'vc2', time: 2, win: true, opponent_id: luigi.id }),
        makeMatch({ id: 'vc3', time: 3, win: false, opponent_id: 8 }),
      ];
      return withRouter(<VsCharactersList fighterId={mario.id} fighterMatches={matches} />);
    },
    rows: (result) => within(result.container).getAllByRole('listitem'),
  },
  {
    name: 'Fighter Analysis vs-players dumbbell list (VsPlayersList)',
    file: 'apps/web/src/pages/FighterAnalysis/components/VsPlayersList.tsx',
    render: () => {
      const matches = [
        makeMatch({ id: 'vp1', time: 1, win: true, opponent: 'foxplayer' }),
        makeMatch({ id: 'vp2', time: 2, win: true, opponent: 'foxplayer' }),
        makeMatch({ id: 'vp3', time: 3, win: false, opponent: 'marthplayer' }),
      ];
      return withRouter(
        <VsPlayersList fighterId={mario.id} fighterMatches={matches} aliasMap={{}} />,
      );
    },
    rows: (result) => within(result.container).getAllByRole('listitem'),
  },
  {
    name: 'Trends setting-comparison dumbbell rows (SettingComparison)',
    file: 'apps/web/src/pages/Trends/components/SettingComparison.tsx',
    render: () => {
      const matches = [
        makeMatch({ id: 'on1', time: 1, win: true, matchType: 'quickplay' }),
        makeMatch({ id: 'on2', time: 2, win: false, matchType: 'quickplay' }),
        makeMatch({ id: 'off1', time: 3, win: true, matchType: 'offline-tourney' }),
        makeMatch({ id: 'off2', time: 4, win: false, matchType: 'offline-tourney' }),
      ];
      return withRouter(
        <SettingComparison matches={matches} horizon="last30" settingGapInsight={null} />,
      );
    },
    rows: (result) => within(result.container).getAllByRole('listitem'),
  },
  {
    // Distinct from the "Recent encounters" entry above (which covers the
    // session-pseudo-set variant on a single manual match) — this fixture
    // gives every game a parseable `externalId` + `eventName` so
    // `groupEncounters` produces a real EVENT-kind group, exercising the
    // `SetRow` variant that variant never reaches.
    name: 'Recent Encounters event-set rows (RecentEncounters, event-grouped)',
    file: 'apps/web/src/pages/Opponents/components/RecentEncounters.tsx',
    render: () => {
      const matches = [
        makeMatch({
          id: 'e1',
          time: 1,
          win: true,
          externalId: 'sgg:100:g1',
          eventName: 'Genesis 9',
        }),
        makeMatch({
          id: 'e2',
          time: 2,
          win: true,
          externalId: 'sgg:100:g2',
          eventName: 'Genesis 9',
        }),
      ];
      return withRouter(<RecentEncounters matches={matches} />);
    },
    rows: (result) => within(result.container).getAllByRole('listitem'),
  },
  // Plan 39.2-07 (TIER-02, UI-SPEC §13 G6): the tier-aware Tournaments table,
  // both roots — every row is a DrillableRow overlay into its event. The
  // fixture spans a dated row, an imported row with no linked games (the
  // Gate 4 dash record) and an undated row, so no shape is left uncovered.
  {
    name: 'Tournaments table (TournamentsTable)',
    file: 'apps/web/src/pages/Tournaments/components/TournamentsTable.tsx',
    render: () =>
      withRouter(
        <TooltipProvider>
          <TournamentsTable rows={tournamentTableFixtureRows()} layout="table" />
        </TooltipProvider>,
      ),
    rows: (result) => dataRows(result.container),
  },
  {
    name: 'Tournaments table, stacked (below 640px)',
    file: 'apps/web/src/pages/Tournaments/components/TournamentsTable.tsx',
    render: () =>
      withRouter(
        <TooltipProvider>
          <TournamentsTable rows={tournamentTableFixtureRows()} layout="stack" />
        </TooltipProvider>,
      ),
    rows: (result) =>
      Array.from(result.container.querySelectorAll<HTMLElement>('[data-slot="tournaments-row"]')),
  },
  // Plan 39.2-08 (TIER-03, UI-SPEC §13 G6): the By-tier card. Rows include the
  // Unknown row in its inset; each is a `DrillableRow` into a `?tier=` filter.
  {
    name: 'By-tier card rows, including the Unknown row (ByTierCard)',
    file: 'apps/web/src/components/analytics/tier/ByTierCard.tsx',
    render: () =>
      withRouter(<ByTierCard stats={byTierFixtureStats()} sideEventCount={0} overallRate={0.6} />),
    rows: (result) =>
      Array.from(result.container.querySelectorAll<HTMLElement>('[data-slot="by-tier-row"]')),
  },
  // Plan 39.2-11 (TRK-02, UI-SPEC §13 G6): the Dashboard Tracked rows, full and
  // compact. Every row of every kind is a `DrillableRow` overlay into the item's
  // own surface; the untrack button is a second, separate control.
  {
    name: 'Tracked rows (TrackedRow, full)',
    file: 'apps/web/src/components/analytics/track/TrackedRow.tsx',
    render: () =>
      withRouter(
        <ul>
          {trackedRowModelsFixture().map((model) => (
            <TrackedRow key={model.itemKey} model={model} onUntrack={() => undefined} />
          ))}
        </ul>,
      ),
    rows: (result) =>
      Array.from(result.container.querySelectorAll<HTMLElement>('[data-slot="tracked-row"]')),
  },
  {
    name: 'Tracked rows (TrackedRow, compact — the digest variant)',
    file: 'apps/web/src/components/analytics/track/TrackedRow.tsx',
    render: () =>
      withRouter(
        <ul>
          {trackedRowModelsFixture().map((model) => (
            <TrackedRow key={model.itemKey} model={model} compact />
          ))}
        </ul>,
      ),
    rows: (result) =>
      Array.from(result.container.querySelectorAll<HTMLElement>('[data-slot="tracked-row"]')),
  },
  // Plan 39.2-12 (UI-SPEC §13 G6): the digest's moved rows as DigestCard mounts them, each
  // carrying its moved token, plus the "and N more" door to #tracked.
  {
    name: "Digest moved rows (DigestCard's compact TrackedRows with moved tokens)",
    file: 'apps/web/src/components/analytics/track/DigestCard.tsx',
    render: () => withRouter(<DigestCard digest={expandedDigestFixture()} />),
    rows: (result) =>
      Array.from(
        result.container.querySelectorAll<HTMLElement>(
          '[data-slot="digest-moved-list"] > [data-slot="tracked-row"]',
        ),
      ),
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
    surface: 'Fighter Analysis opponent table, stacked (below 640px)',
    reason: 'unnamed-opponent bucket',
    predicate: (row) => row.textContent?.includes('unknown') === true,
  },
  {
    surface: 'Absorbed hub card: what-they-play, stacked (below 640px)',
    reason: 'unknown character',
    predicate: (row) => row.textContent?.includes('Unknown') === true,
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

  it("the surface enumeration has the stated THIRTY-EIGHT entries (18 + 39.1-21's 7 + 39.1-23's 1 + 39.1-49's 4 stacked layouts + 39.1-46's stage breakdown and insights rows + 39.2-07's 2 Tournaments table roots + 39.2-08's By-tier card + 39.2-11's 2 Tracked row variants + 39.2-12's digest moved rows)", () => {
    expect(SURFACES.length).toBe(38);
  });

  it("the digest's moved rows are each a door to their own surface, carry a moved token, and 'and N more' leads to #tracked (plan 39.2-12 non-vacuity)", async () => {
    const surface = SURFACES.find((s) => s.name.startsWith('Digest moved rows'))!;
    const result = await renderReady(surface);
    const rows = surface.rows(result);
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.querySelector('a')?.getAttribute('href')).toBeTruthy();
      expect(row.querySelector('[data-slot="tracked-row-moved"]')?.textContent).toMatch(/^moved/);
    }
    expect(result.container.querySelector('[data-slot="digest-more"]')).toHaveAttribute(
      'href',
      '/dashboard#tracked',
    );
    result.unmount();
  });

  it('the Tracked entries enumerate one row per kind and each is a door to its own surface (plan 39.2-11 non-vacuity)', async () => {
    for (const name of ['Tracked rows (TrackedRow, full)', 'Tracked rows (TrackedRow, compact']) {
      const surface = SURFACES.find((s) => s.name.startsWith(name))!;
      const result = await renderReady(surface);
      const rows = surface.rows(result);
      expect(rows.map((row) => row.getAttribute('data-kind')).sort()).toEqual([
        'matchup',
        'opponent',
        'stage',
      ]);
      const hrefs = rows.map((row) => row.querySelector('a')?.getAttribute('href'));
      expect(hrefs).toEqual(
        expect.arrayContaining([
          '/opponents/rival',
          `/matchups?fighter=${mario.id}&vs=${luigi.id}`,
          '/stages/1',
        ]),
      );
      result.unmount();
    }
  });

  it('the By-tier entry enumerates a plain tier row, an abstaining tier row and the Unknown row (plan 39.2-08 non-vacuity)', async () => {
    const surface = SURFACES.find((s) => s.name.startsWith('By-tier card rows'))!;
    const result = await renderReady(surface);
    const tiers = surface.rows(result).map((row) => row.getAttribute('data-tier'));
    expect(tiers).toContain('unknown');
    expect(tiers).toContain('supermajor');
    // The abstaining row draws no bar but is still a door.
    const abstaining = surface
      .rows(result)
      .find((row) => row.getAttribute('data-tier') === 'minor')!;
    expect(abstaining.querySelector('[data-slot="by-tier-bar"]')).toBeNull();
    expect(accessibleInteractiveDescendant(abstaining)).not.toBeNull();
    result.unmount();
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
