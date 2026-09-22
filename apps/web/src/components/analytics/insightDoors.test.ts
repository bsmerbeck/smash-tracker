import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  buildRateClaim,
  type Insight,
  type InsightDoor,
  type InsightTemplateId,
} from '@smash-tracker/shared';
import type { Match } from '@smash-tracker/shared';
import { buildInsightDoors, resolveInsightClaim, DD09_CLAIM_AXIS_ACCEPTED } from './insightDoors';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(path.join(THIS_DIR, 'insightDoors.ts'), 'utf-8');
/** Strip comments so doc-comment prose (which legitimately NAMES template ids for documentation) can't produce a false failure below. */
const SOURCE_WITHOUT_COMMENTS = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

const NOW_MS = 1_700_100_000_000;
const ONE_HOUR_MS = 60 * 60 * 1000;

function makeMatch(overrides: Partial<Match> = {}): Match {
  return {
    id: 'm1',
    fighter_id: 8,
    opponent_id: 2,
    time: NOW_MS,
    win: true,
    ...overrides,
  } as Match;
}

const emptyRateClaim = buildRateClaim({
  rate: { wins: 3, losses: 0, total: 3, rate: 1 },
  refreshedAt: NOW_MS,
  dateRange: { fromMs: NOW_MS - 3 * ONE_HOUR_MS, toMs: NOW_MS },
});

function makeInsight(overrides: Partial<Insight> & { templateId: InsightTemplateId }): Insight {
  return {
    id: `${overrides.templateId}:account:last30`,
    scopeKey: 'account',
    horizon: 'last30',
    kind: 'fact',
    state: 'fact',
    recent: emptyRateClaim,
    baseline: emptyRateClaim,
    deltaPoints: null,
    window: {
      horizon: 'last30',
      fromMs: NOW_MS - 3 * ONE_HOUR_MS,
      toMs: NOW_MS,
      games: 3,
      scoped: false,
    },
    salience: 0,
    copy: { key: 'insights.x.fact', values: {} },
    doors: [],
    countedMatchIds: [],
    ...overrides,
  };
}

const identitySubjectPath = (path: string) => path;

describe('DD09_CLAIM_AXIS_ACCEPTED', () => {
  it('records the accepted decision (Task 1, 2026-09-21)', () => {
    expect(DD09_CLAIM_AXIS_ACCEPTED).toBe(true);
  });
});

describe('buildInsightDoors', () => {
  it('reads windowExpressible off the registry — asserted with a source scan finding no hand-written template-id list', () => {
    // Static companion to the runtime assertions below: the module must
    // never enumerate template ids to decide "in scope".
    expect(SOURCE_WITHOUT_COMMENTS).not.toMatch(/\[\s*'formNow'\s*,/);
    expect(SOURCE_WITHOUT_COMMENTS).toMatch(/windowExpressible/);
  });

  it('a window-expressible template (formNow) gets the counted-games door built with claim=', () => {
    const insight = makeInsight({ templateId: 'formNow', doors: [] });
    const doors = buildInsightDoors({ insight, subjectPath: identitySubjectPath });
    expect(doors).toHaveLength(1);
    expect(doors[0]!.kind).toBe('games');
    expect(doors[0]!.count).toBe(3);
    expect(doors[0]!.href).toContain('claim=formNow%3Aaccount%3Alast30');
    expect(doors[0]!.href).toContain('#games');
  });

  it('the games door href is a same-route relative link, never routed through subjectPath', () => {
    const subjectPath = vi.fn((p: string) => `/coach/xyz${p}`);
    const insight = makeInsight({ templateId: 'formNow' });
    const doors = buildInsightDoors({ insight, subjectPath });
    expect(subjectPath).not.toHaveBeenCalled();
    expect(doors[0]!.href.startsWith('?')).toBe(true);
  });

  const nonExpressibleFallbacks: Array<{
    templateId: InsightTemplateId;
    doors: InsightDoor[];
    expectedKind: string | undefined;
    expectedRoute?: string;
  }> = [
    {
      templateId: 'secondaryPayoff',
      doors: [{ kind: 'matchup', axes: { fighter: 9, vs: 2 }, count: 5 }],
      expectedKind: 'matchup',
      expectedRoute: '/matchups',
    },
    {
      templateId: 'matchupOrPlayer',
      doors: [{ kind: 'opponent', axes: { fighter: 8, vs: 2 }, count: 3 }],
      expectedKind: 'opponent',
      expectedRoute: '/matchups',
    },
    { templateId: 'tiltCost', doors: [], expectedKind: undefined },
    { templateId: 'sessionFatigue', doors: [], expectedKind: undefined },
    { templateId: 'volumeForm', doors: [], expectedKind: undefined },
    { templateId: 'pocketCost', doors: [], expectedKind: undefined },
  ];

  it.each(nonExpressibleFallbacks)(
    'under either branch, $templateId (non-expressible) receives exactly its named fallback door, never a counted-games door',
    ({ templateId, doors, expectedKind, expectedRoute }) => {
      const insight = makeInsight({ templateId, doors });
      const built = buildInsightDoors({ insight, subjectPath: identitySubjectPath });
      expect(built.some((door) => door.kind === 'games')).toBe(false);
      if (expectedKind === undefined) {
        expect(built).toHaveLength(0);
      } else {
        expect(built).toHaveLength(1);
        expect(built[0]!.kind).toBe(expectedKind);
        expect(built[0]!.href.startsWith(expectedRoute!)).toBe(true);
      }
    },
  );

  it('no second URL-building helper exists — every href funnels through buildDrillDownSearch', () => {
    const declarations = SOURCE_WITHOUT_COMMENTS.match(/function build\w*Search\s*\(/g) ?? [];
    expect(declarations).toHaveLength(0);
  });

  it('no door handler mutates persisted state — buildInsightDoors never touches storage', () => {
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem');
    const insight = makeInsight({
      templateId: 'secondaryPayoff',
      doors: [{ kind: 'matchup', axes: { fighter: 9, vs: 2 }, count: 5 }],
    });
    buildInsightDoors({
      insight: makeInsight({ templateId: 'formNow' }),
      subjectPath: identitySubjectPath,
    });
    buildInsightDoors({ insight, subjectPath: identitySubjectPath });
    expect(setItemSpy).not.toHaveBeenCalled();
    setItemSpy.mockRestore();
  });
});

describe('resolveInsightClaim', () => {
  it('resolves a window-expressible insight to exactly its recorded window, in-bounds only', () => {
    const inBound = makeMatch({ id: 'a', time: NOW_MS - ONE_HOUR_MS });
    const outOfBound = makeMatch({ id: 'b', time: NOW_MS - 100 * ONE_HOUR_MS });
    const insight = makeInsight({
      templateId: 'formNow',
      window: {
        horizon: 'last30',
        fromMs: NOW_MS - 2 * ONE_HOUR_MS,
        toMs: NOW_MS,
        games: 1,
        scoped: false,
      },
      doors: [{ kind: 'games', axes: {}, count: 1 }],
    });
    const resolved = resolveInsightClaim({
      claimId: insight.id,
      insights: [insight],
      matches: [inBound, outOfBound],
    });
    expect(resolved).toEqual([inBound]);
  });

  it('honors an identity axis (fighter=) from the door — narrows even without a time bound (rosterCore-shaped)', () => {
    const mainFighter = makeMatch({ id: 'main-1', fighter_id: 9 });
    const otherFighter = makeMatch({ id: 'other-1', fighter_id: 2 });
    const insight = makeInsight({
      templateId: 'rosterCore',
      window: { horizon: 'last30', fromMs: null, toMs: null, games: 1, scoped: false },
      doors: [{ kind: 'games', axes: { fighter: 9 }, count: 1 }],
    });
    const resolved = resolveInsightClaim({
      claimId: insight.id,
      insights: [insight],
      matches: [mainFighter, otherFighter],
    });
    expect(resolved).toEqual([mainFighter]);
  });

  it('the named failing case: a tied edge timestamp over-counts before the trim, and is trimmed to exactly the door count after', () => {
    const tieMs = NOW_MS;
    const inWindow = makeMatch({ id: 'newest', time: tieMs });
    const tiedExtra = makeMatch({ id: 'tied-extra', time: tieMs });
    const insight = makeInsight({
      templateId: 'formNow',
      window: { horizon: 'last30', fromMs: tieMs, toMs: tieMs, games: 1, scoped: false },
      doors: [{ kind: 'games', axes: {}, count: 1 }],
    });
    // PRE-FIX proof: a naive from/to reconstruction with no trim would
    // return BOTH tied games (2), not the door's own count (1) — the exact
    // over-count UI-SPEC §13.13 names as the guard's failing case.
    const naiveCandidateCount = [inWindow, tiedExtra].filter(
      (m) => m.time >= tieMs && m.time <= tieMs,
    ).length;
    expect(naiveCandidateCount).toBe(2);
    expect(naiveCandidateCount).not.toBe(insight.window.games);

    // POST-FIX: the shipped resolver trims to exactly the door's count.
    const resolved = resolveInsightClaim({
      claimId: insight.id,
      insights: [insight],
      matches: [inWindow, tiedExtra],
    });
    expect(resolved).toHaveLength(1);
  });

  it('returns undefined for an unknown/stale claim id, never throws', () => {
    expect(() =>
      resolveInsightClaim({ claimId: 'nope:account:last30', insights: [], matches: [] }),
    ).not.toThrow();
    expect(
      resolveInsightClaim({ claimId: 'nope:account:last30', insights: [], matches: [] }),
    ).toBeUndefined();
  });

  it('returns undefined for a non-window-expressible template — the resolver never fabricates a games set it cannot prove', () => {
    const insight = makeInsight({ templateId: 'tiltCost', doors: [] });
    const resolved = resolveInsightClaim({
      claimId: insight.id,
      insights: [insight],
      matches: [makeMatch()],
    });
    expect(resolved).toBeUndefined();
  });

  it('the resolver narrows within the already-loaded array only — never widens beyond it (elevation-of-privilege guard)', () => {
    const loaded = makeMatch({ id: 'loaded', time: NOW_MS });
    const insight = makeInsight({
      templateId: 'formNow',
      window: {
        horizon: 'last30',
        fromMs: NOW_MS - ONE_HOUR_MS,
        toMs: NOW_MS,
        games: 1,
        scoped: false,
      },
      doors: [{ kind: 'games', axes: {}, count: 1 }],
    });
    const resolved = resolveInsightClaim({
      claimId: insight.id,
      insights: [insight],
      matches: [loaded],
    });
    expect(resolved).toEqual([loaded]);
    expect(resolved!.every((m) => [loaded].includes(m))).toBe(true);
  });
});
