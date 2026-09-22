import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClientProvider, QueryClient } from '@tanstack/react-query';
import {
  INSIGHT_TEMPLATES,
  type Insight,
  type InsightScope,
  type InsightTemplateId,
  type Match,
} from '@smash-tracker/shared';
import { generateSyntheticMatches, EIGHT_K_FIXTURE_OPTIONS } from '@smash-tracker/shared/testUtils';
import { AuthProvider } from '@/context/AuthContext';
import { resetAuthMock, setMockUser, makeMockUser } from '@/test/mockAuth';
import { FilteredMatchList } from './FilteredMatchList';
import { readDrillDownParams } from '@/lib/drillDownParams';
import { buildInsightDoors, resolveInsightClaim, eventKeyOf } from './analytics/insightDoors';

/**
 * Plan 39.1-19 Task 3, closed out by plan 39.1-22 (gap closure, orchestrator
 * Finding 8) — UI-SPEC §13.13/§13.13a's same-n door test, now covering ALL
 * 17 registered templates in ONE uniform branch (never a windowExpressible
 * split): a counted-games door is present iff the built `Insight`'s
 * `countedMatchIds` is non-empty, `door.count === countedMatchIds.length`,
 * and the `FilteredMatchList` at the door's destination renders exactly that
 * many rows — proven by actually rendering it, not just asserting the
 * resolver's return value (see `insightDoors.test.ts` for the resolver-only
 * unit coverage, including the tied-timestamp and elevation-of-privilege
 * cases).
 *
 * Registry-driven throughout: `INSIGHT_TEMPLATES` itself drives
 * `describe.each` below, never a hand-written template-id array.
 */

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

vi.mock('@/lib/api', () => ({
  api: {
    users: { upsertMe: vi.fn().mockResolvedValue({ uid: 'test-uid', email: 't@example.com' }) },
    matches: { remove: vi.fn().mockResolvedValue(undefined) },
  },
}));

const NOW_MS = 1_700_100_000_000;
const HOUR = 60 * 60 * 1000;

function accountScope(): InsightScope {
  return { kind: 'account', key: 'account', axes: {}, filter: (matches) => matches };
}

function characterScope(fighterId: number): InsightScope {
  return {
    kind: 'character',
    key: `character:${fighterId}`,
    axes: { fighter: fighterId },
    filter: (matches) => matches.filter((m) => m.fighter_id === fighterId),
  };
}

function pairingScope(fighterId: number, opponentFighterId: number): InsightScope {
  return {
    kind: 'character',
    key: `character:${fighterId}:vs:${opponentFighterId}`,
    axes: { fighter: fighterId, vs: opponentFighterId },
    filter: (matches) =>
      matches.filter((m) => m.fighter_id === fighterId && m.opponent_id === opponentFighterId),
  };
}

/** The plain 8k synthetic fixture — produces a non-empty, non-hidden result for most of the 17 templates directly. */
const eightK = generateSyntheticMatches(EIGHT_K_FIXTURE_OPTIONS);
const SUBJECT_FIGHTER_ID = 8; // Fox — a default main in EIGHT_K_FIXTURE_OPTIONS.
const OPPONENT_FIGHTER_ID = 2;

function buildLastEventRecapFixture(): Match[] {
  const matches: Match[] = [];
  for (let i = 0; i < 5; i += 1) {
    matches.push({
      id: `ler-${i}`,
      fighter_id: SUBJECT_FIGHTER_ID,
      opponent_id: OPPONENT_FIGHTER_ID,
      time: NOW_MS - (5 - i) * HOUR,
      win: i % 2 === 0,
      eventName: 'Genesis 12',
    } as Match);
  }
  return matches;
}

function buildMixShiftFixture(): Match[] {
  const matches: Match[] = [];
  for (let i = 0; i < 70; i += 1) {
    matches.push({
      id: `mix-old-${i}`,
      fighter_id: SUBJECT_FIGHTER_ID,
      opponent_id: OPPONENT_FIGHTER_ID,
      time: NOW_MS - (1000 - i) * HOUR,
      win: i % 2 === 0,
      matchType: 'offline-tourney',
    } as Match);
  }
  for (let i = 0; i < 30; i += 1) {
    matches.push({
      id: `mix-recent-${i}`,
      fighter_id: SUBJECT_FIGHTER_ID,
      opponent_id: OPPONENT_FIGHTER_ID,
      time: NOW_MS - (30 - i) * HOUR,
      win: i % 2 === 0,
      matchType: 'quickplay',
    } as Match);
  }
  return matches;
}

const ROSTER_SHIFT_BASELINE_FIGHTER_ID = 9;
const ROSTER_SHIFT_RECENT_FIGHTER_ID = 20;

function buildRosterShiftFixture(): Match[] {
  const matches: Match[] = [];
  for (let i = 0; i < 200; i += 1) {
    matches.push({
      id: `rs-base-${i}`,
      fighter_id: ROSTER_SHIFT_BASELINE_FIGHTER_ID,
      opponent_id: OPPONENT_FIGHTER_ID,
      time: NOW_MS - (1000 - i) * HOUR,
      win: i % 2 === 0,
      matchType: 'offline-tourney',
    } as Match);
  }
  for (let i = 0; i < 30; i += 1) {
    matches.push({
      id: `rs-recent-${i}`,
      fighter_id: ROSTER_SHIFT_RECENT_FIGHTER_ID,
      opponent_id: OPPONENT_FIGHTER_ID,
      time: NOW_MS - (30 - i) * HOUR,
      win: i % 2 === 0,
      matchType: 'quickplay',
    } as Match);
  }
  return matches;
}

/** One fixture-and-scope pair per registered template — the SET this guard iterates is `INSIGHT_TEMPLATES` itself (`Object.keys` of this map is asserted to equal it below), never a literal array written in an assertion loop. */
const FIXTURES: Record<InsightTemplateId, { matches: Match[]; scope: InsightScope }> = {
  formNow: { matches: eightK, scope: accountScope() },
  characterMovers: { matches: eightK, scope: characterScope(SUBJECT_FIGHTER_ID) },
  rivalMovers: { matches: eightK, scope: characterScope(SUBJECT_FIGHTER_ID) },
  lastEventRecap: {
    matches: buildLastEventRecapFixture(),
    scope: characterScope(SUBJECT_FIGHTER_ID),
  },
  bestMatchup: { matches: eightK, scope: characterScope(SUBJECT_FIGHTER_ID) },
  worstMatchup: { matches: eightK, scope: characterScope(SUBJECT_FIGHTER_ID) },
  settingGap: { matches: eightK, scope: accountScope() },
  ratingMove: { matches: eightK, scope: accountScope() },
  mixShift: { matches: buildMixShiftFixture(), scope: accountScope() },
  rosterCore: { matches: eightK, scope: accountScope() },
  rosterShift: { matches: buildRosterShiftFixture(), scope: accountScope() },
  matchupOrPlayer: {
    matches: eightK,
    scope: pairingScope(SUBJECT_FIGHTER_ID, OPPONENT_FIGHTER_ID),
  },
  tiltCost: { matches: eightK, scope: accountScope() },
  sessionFatigue: { matches: eightK, scope: accountScope() },
  volumeForm: { matches: eightK, scope: accountScope() },
  secondaryPayoff: { matches: eightK, scope: accountScope() },
  pocketCost: { matches: eightK, scope: accountScope() },
};

function buildInsight(templateId: InsightTemplateId): Insight {
  const template = INSIGHT_TEMPLATES.find((candidate) => candidate.id === templateId)!;
  const { matches, scope } = FIXTURES[templateId];
  const insights = template.build({ matches, scope, horizon: 'last30', nowMs: NOW_MS });
  expect(
    insights,
    `${templateId} must produce exactly one real Insight on its fixture`,
  ).toHaveLength(1);
  return insights[0]!;
}

const identitySubjectPath = (path: string) => path;

function renderFilteredMatchListAtDoor(insight: Insight, matches: Match[], doorHref: string) {
  const [, query = ''] = doorHref.split('?');
  const search = new URLSearchParams(query.split('#')[0] ?? '');
  const axes = readDrillDownParams(search, { stageIds: new Set() });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/matchups']}>
        <AuthProvider>
          <Routes>
            <Route
              path="/matchups"
              element={
                <FilteredMatchList
                  matches={matches}
                  axes={axes}
                  eventKeyForMatch={eventKeyOf}
                  resolveClaim={(claimId, ms) =>
                    resolveInsightClaim({ claimId, insights: [insight], matches: ms })
                  }
                />
              }
            />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/**
 * Plan 39.1-23 (next, sequential in this same wave) caps FilteredMatchList's
 * rendered rows behind a "Show all" control. When that lands, the terminus
 * is expected to expose the FULL row count via a `data-total-rows` attribute
 * on the table even while only a capped subset is actually rendered — this
 * helper reads that attribute when present. Until 39.1-23 lands, it falls
 * back to counting rendered `<tr>` rows directly (today's exact behavior,
 * since FilteredMatchList renders every matched row uncapped).
 */
function renderedRowCount(): number {
  const table = screen.getByRole('table');
  const totalRowsAttr = table.getAttribute('data-total-rows');
  if (totalRowsAttr !== null) {
    const parsed = Number.parseInt(totalRowsAttr, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  // Header + body rows — subtract the header row (matches this repo's own
  // established convention in FilteredMatchList.test.tsx).
  return within(table).getAllByRole('row').length - 1;
}

beforeEach(() => {
  resetAuthMock();
  setMockUser(makeMockUser());
});

describe('registry coverage', () => {
  it("FIXTURES covers exactly the registry's 17 templates", () => {
    expect(INSIGHT_TEMPLATES).toHaveLength(17);
    expect(new Set(Object.keys(FIXTURES))).toEqual(new Set(INSIGHT_TEMPLATES.map((t) => t.id)));
  });
});

const SAME_N_DOOR_TIMEOUT_MS = 60_000;

describe.each(INSIGHT_TEMPLATES.map((t) => t.id))('template %s', (templateId) => {
  it(
    'counted-games door: present with the exact same-n row count iff the insight counted at least one game',
    () => {
      const insight = buildInsight(templateId);
      const doors = buildInsightDoors({ insight, subjectPath: identitySubjectPath });
      const gamesDoor = doors.find((d) => d.kind === 'games');

      if (insight.countedMatchIds.length === 0) {
        expect(
          gamesDoor,
          `${templateId} counted zero games (countedMatchIds is empty) — must render no counted-games door`,
        ).toBeUndefined();
        return;
      }

      expect(
        gamesDoor,
        `${templateId} counted ${insight.countedMatchIds.length} games — must render a counted-games door`,
      ).toBeDefined();
      expect(gamesDoor!.count).toBe(insight.countedMatchIds.length);

      const { matches } = FIXTURES[templateId];
      renderFilteredMatchListAtDoor(insight, matches, gamesDoor!.href);
      expect(renderedRowCount()).toBe(gamesDoor!.count);
      // Whole-history reads (settingGap, rosterCore) land on thousands of rows of the 8k
      // fixture, and FilteredMatchList renders every one: ~5s alone, past the 15s default
      // when `pnpm test` runs the shared/api/web suites concurrently.
    },
    SAME_N_DOOR_TIMEOUT_MS,
  );
});

describe('named case: a tied edge timestamp is exact by construction, no trim needed', () => {
  it('countedMatchIds names exactly the one intended game — the shipped behavior', () => {
    const tieMs = NOW_MS;
    const matches: Match[] = [
      {
        id: 'newest',
        fighter_id: SUBJECT_FIGHTER_ID,
        opponent_id: OPPONENT_FIGHTER_ID,
        time: tieMs,
        win: true,
      } as Match,
      {
        id: 'tied-extra',
        fighter_id: SUBJECT_FIGHTER_ID,
        opponent_id: OPPONENT_FIGHTER_ID,
        time: tieMs,
        win: false,
      } as Match,
    ];
    const insight: Insight = {
      id: 'formNow:account:last30',
      templateId: 'formNow',
      scopeKey: 'account',
      horizon: 'last30',
      kind: 'fact',
      state: 'fact',
      recent: {
        kind: 'evidenced',
        claimType: 'fact',
        value: { wins: 1, losses: 0, total: 1, rate: 1 },
        sample: {
          rawSampleSize: 1,
          eligibleDenominator: 1,
          knownFieldCoverage: 1,
          dateRange: { firstMs: tieMs, lastMs: tieMs },
          refreshedAt: NOW_MS,
          evidencePolicyVersion: 1,
          recencyTreatment: 'unweighted',
          confidenceTier: null,
        },
      },
      baseline: {
        kind: 'evidenced',
        claimType: 'fact',
        value: { wins: 1, losses: 0, total: 1, rate: 1 },
        sample: {
          rawSampleSize: 1,
          eligibleDenominator: 1,
          knownFieldCoverage: 1,
          dateRange: { firstMs: tieMs, lastMs: tieMs },
          refreshedAt: NOW_MS,
          evidencePolicyVersion: 1,
          recencyTreatment: 'unweighted',
          confidenceTier: null,
        },
      },
      deltaPoints: null,
      window: { horizon: 'last30', fromMs: tieMs, toMs: tieMs, games: 1, scoped: false },
      salience: 0,
      copy: { key: 'insights.formNow.fact', values: {} },
      doors: [{ kind: 'games', axes: {}, count: 1 }],
      // The whole point: countedMatchIds names ONE id, never both tied games —
      // no window/axis reconstruction, no trim, no ambiguity about which side
      // of the tie was meant.
      countedMatchIds: ['newest'],
    };

    // Documentation of what countedMatchIds makes unnecessary: a naive
    // inclusive [fromMs, toMs] reconstruction over this tied boundary would
    // have returned BOTH games (2) — the over-count UI-SPEC §13.13 named.
    const naive = matches.filter((m) => m.time >= tieMs && m.time <= tieMs);
    expect(naive.length).toBe(2);
    expect(naive.length).not.toBe(insight.countedMatchIds.length);

    const resolved = resolveInsightClaim({ claimId: insight.id, insights: [insight], matches });
    expect(resolved).toHaveLength(1);
    expect(resolved![0]!.id).toBe('newest');

    const doors = buildInsightDoors({ insight, subjectPath: identitySubjectPath });
    const gamesDoor = doors.find((d) => d.kind === 'games')!;
    renderFilteredMatchListAtDoor(insight, matches, gamesDoor.href);
    expect(renderedRowCount()).toBe(gamesDoor.count);
  });
});
