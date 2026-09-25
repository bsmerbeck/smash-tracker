import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
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
import {
  FilteredMatchList,
  FILTERED_MATCH_LIST_ROW_CAP,
  FILTERED_MATCH_LIST_PAGE_SIZE,
} from './FilteredMatchList';
import { readDrillDownParams } from '@/lib/drillDownParams';
import {
  buildInsightDoors,
  resolveInsightClaim,
  eventKeyOf,
  type InsightDoorDescriptor,
} from './analytics/insightDoors';
import { INSIGHT_DOOR_HOSTS } from '@/test/insightDoorHosts';

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
 * Plan 39.1-23: `FilteredMatchList` caps rendered rows at
 * `FILTERED_MATCH_LIST_ROW_CAP` behind a "Show all" control, exposing the
 * FULL row count via a `data-total-rows` attribute on the table even while
 * only a capped subset is actually mounted. This helper reads that attribute
 * when present (the normal case now) and falls back to counting rendered
 * `<tr>` rows directly (a defensive fallback only — every template's fixture
 * renders a real `<table>` with the attribute set). The describe block below
 * named "same-n door guard: capped rendering still proves rendered ==
 * printed" additionally clicks Show all for a template whose door exceeds
 * the cap and counts real `<tr>`s, proving the attribute is not lying.
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

  /**
   * Plan 39.1-29 (gap closure, SC4/INS-04): this file's own per-template
   * guard proves the DOOR is exact once a `FilteredMatchList` is rendered
   * directly at the door's own href — Finding 10 showed that a library-level
   * guard nothing renders through a real page proves nothing. This case
   * closes that gap AT THE SOURCE: every registered template must have at
   * least one entry in `INSIGHT_DOOR_HOSTS` (imported from
   * `@/test/insightDoorHosts`, the page-level reachability suite's own
   * registry, `insightDoorReachability.test.tsx`) — so a future template
   * that ships with no live host fails HERE, in the library guard, not only
   * in the (much slower) page suite.
   */
  it('every registered template has at least one live host in INSIGHT_DOOR_HOSTS', () => {
    for (const template of INSIGHT_TEMPLATES) {
      const hosts = INSIGHT_DOOR_HOSTS[template.id];
      expect(hosts, `${template.id} is missing from INSIGHT_DOOR_HOSTS`).toBeDefined();
      expect(
        hosts.length,
        `${template.id} has zero live hosts in INSIGHT_DOOR_HOSTS`,
      ).toBeGreaterThan(0);
    }
  });
});

/**
 * Plan 39.1-23: with the row cap in place, every per-template test in the
 * `describe.each` loop below now renders at most FILTERED_MATCH_LIST_ROW_CAP
 * rows and finishes in well under 200ms (measured: the previously-slowest
 * cases — settingGap, volumeForm, tiltCost, rosterCore, pocketCost — dropped
 * from 1.4–6.6s each to 80–120ms each). The one test that still renders every
 * row (the real Show-all expansion below, deliberately proving
 * `data-total-rows` isn't lying) measured ~5.5s alone. The pre-cap 60s bound
 * was set because that same ~5s figure could exceed the 15s default under
 * `pnpm test`'s full concurrent shared/api/web run; kept a smaller-but-safe
 * 20s here rather than dropping all the way to the 15s default this exact
 * scenario once blew past.
 */
const SAME_N_DOOR_TIMEOUT_MS = 20_000;

/** The active-filter summary `<p>` — the header text that must always state the FULL printed n, never the mounted row count (plan 39.1-28). */
function summaryLineText(container: HTMLElement): string | null {
  return container.querySelector('.border-border p')?.textContent ?? null;
}

describe.each(INSIGHT_TEMPLATES.map((t) => t.id))('template %s', (templateId) => {
  it(
    'counted-games door: present with the exact same-n row count iff the insight counted at least one game — header/data-total-rows state the count, never the mounted rows',
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
      const { container } = renderFilteredMatchListAtDoor(insight, matches, gamesDoor!.href);
      expect(renderedRowCount()).toBe(gamesDoor!.count);
      // Plan 39.1-23/39.1-28: `renderedRowCount()` reads `data-total-rows`, so
      // this assertion holds even for whole-history reads (settingGap,
      // rosterCore) whose doors land thousands of rows on the 8k fixture —
      // FilteredMatchList now mounts at most FILTERED_MATCH_LIST_ROW_CAP of
      // them per pass, never all at once.
      //
      // Plan 39.1-28: the header (active-filter summary line) ALSO states the
      // full printed n — the same guarantee `data-total-rows` makes, proven a
      // second way, at the surface a real user actually reads.
      expect(summaryLineText(container)).toContain(String(gamesDoor!.count));
    },
    SAME_N_DOOR_TIMEOUT_MS,
  );
});

/**
 * Plan 39.1-28 (owner decision 2026-09-22): replaces the settingGap-specific
 * one-step "Show all" expansion case with a registry-driven paging-to-
 * exhaustion case. The template is chosen PROGRAMMATICALLY — the smallest
 * door count strictly greater than `FILTERED_MATCH_LIST_ROW_CAP` — rather
 * than hand-picked, so this case stays correct if any template's fixture
 * changes shape in the future.
 */
describe('same-n door guard: paging to exhaustion proves rendered == printed through 100-row pages (plan 39.1-28)', () => {
  it(
    'pages the smallest over-cap door to exhaustion, never mounting more than the page size per activation, ending at the exact door count',
    () => {
      const candidates = INSIGHT_TEMPLATES.map((template) => {
        const insight = buildInsight(template.id);
        const doors = buildInsightDoors({ insight, subjectPath: identitySubjectPath });
        const gamesDoor = doors.find((d) => d.kind === 'games');
        return { templateId: template.id, insight, gamesDoor, count: gamesDoor?.count ?? 0 };
      }).filter(
        (
          c,
        ): c is {
          templateId: InsightTemplateId;
          insight: Insight;
          gamesDoor: InsightDoorDescriptor;
          count: number;
        } => c.gamesDoor != null && c.count > FILTERED_MATCH_LIST_ROW_CAP,
      );

      expect(
        candidates.length,
        `no template's door count exceeds FILTERED_MATCH_LIST_ROW_CAP (${FILTERED_MATCH_LIST_ROW_CAP}) — per-template counts: ${INSIGHT_TEMPLATES.map(
          (t) => `${t.id}=${buildInsight(t.id).countedMatchIds.length}`,
        ).join(', ')}`,
      ).toBeGreaterThan(0);

      const chosen = candidates.reduce((min, c) => (c.count < min.count ? c : min));

      // Runtime bound: this test fixture family tops out at 8k rows; a
      // chosen count above 1,000 would make this a real slow-test risk
      // rather than a bounded exhaustion proof.
      expect(
        chosen.count,
        `chosen paging template (${chosen.templateId}) door count ${chosen.count} exceeds the 1,000-row runtime bound`,
      ).toBeLessThanOrEqual(1000);

      const { matches } = FIXTURES[chosen.templateId];
      renderFilteredMatchListAtDoor(chosen.insight, matches, chosen.gamesDoor.href);
      const table = screen.getByRole('table');

      // First render: capped, never the full door count of real <tr>s.
      let mounted = within(table).getAllByRole('row').length - 1;
      expect(mounted).toBe(FILTERED_MATCH_LIST_ROW_CAP);

      let button = screen.queryByRole('button', { name: /show \d+ more/i });
      while (button) {
        fireEvent.click(button);
        const newMounted = within(table).getAllByRole('row').length - 1;
        expect(newMounted - mounted).toBeLessThanOrEqual(FILTERED_MATCH_LIST_PAGE_SIZE);
        mounted = newMounted;
        button = screen.queryByRole('button', { name: /show \d+ more/i });
      }

      // Post-exhaustion: every counted game is a real mounted <tr>, counted
      // directly — proving `data-total-rows` was never lying about what the
      // rest of the guard, above, takes on the attribute's word alone.
      expect(mounted).toBe(chosen.gamesDoor.count);
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
