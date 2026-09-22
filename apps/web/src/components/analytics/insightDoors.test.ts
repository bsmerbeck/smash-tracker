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

/**
 * Plan 39.1-22 (gap closure, orchestrator Finding 8): rewritten for the
 * countedMatchIds door predicate — `buildInsightDoors`/`resolveInsightClaim`
 * no longer read `windowExpressible` at all; a games door is exact by
 * construction whenever `Insight.countedMatchIds` is non-empty, for ALL 17
 * templates, not just the 10 that were `windowExpressible: true`.
 */

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
  it('windowExpressible is no longer read at all — asserted with a source scan', () => {
    expect(SOURCE_WITHOUT_COMMENTS).not.toMatch(/windowExpressible/);
  });

  it('an insight with countedMatchIds gets the counted-games door built with claim=, count = countedMatchIds.length', () => {
    const insight = makeInsight({
      templateId: 'formNow',
      doors: [],
      countedMatchIds: ['a', 'b', 'c'],
    });
    const doors = buildInsightDoors({ insight, subjectPath: identitySubjectPath });
    expect(doors).toHaveLength(1);
    expect(doors[0]!.kind).toBe('games');
    expect(doors[0]!.count).toBe(3);
    expect(doors[0]!.href).toContain('claim=formNow%3Aaccount%3Alast30');
    expect(doors[0]!.href).toContain('#games');
  });

  it('T-39.1-24 (gap closure, Task 2): an anchor override changes the games door scroll target without changing which games it resolves to', () => {
    const insight = makeInsight({
      templateId: 'matchupOrPlayer',
      doors: [{ kind: 'opponent', axes: { fighter: 8, vs: 2 }, count: 3 }],
      countedMatchIds: ['a', 'b'],
    });
    const defaultDoors = buildInsightDoors({ insight, subjectPath: identitySubjectPath });
    expect(defaultDoors[0]!.href).toMatch(/#games$/);

    const anchoredDoors = buildInsightDoors({
      insight,
      subjectPath: identitySubjectPath,
      anchor: '#matchup-table',
    });
    expect(anchoredDoors[0]!.kind).toBe('games');
    expect(anchoredDoors[0]!.count).toBe(2);
    expect(anchoredDoors[0]!.href).toMatch(/#matchup-table$/);
    expect(anchoredDoors[0]!.href).toContain('claim=matchupOrPlayer%3Aaccount%3Alast30');
    // The fallback door is unaffected by the anchor override.
    expect(anchoredDoors[1]!.kind).toBe('opponent');
  });

  it('the games door href is a same-route relative link, never routed through subjectPath', () => {
    const subjectPath = vi.fn((p: string) => `/coach/xyz${p}`);
    const insight = makeInsight({ templateId: 'formNow', countedMatchIds: ['a'] });
    const doors = buildInsightDoors({ insight, subjectPath });
    expect(subjectPath).not.toHaveBeenCalled();
    expect(doors[0]!.href.startsWith('?')).toBe(true);
  });

  it('an insight with an EMPTY countedMatchIds gets no counted-games door at all', () => {
    const insight = makeInsight({ templateId: 'tiltCost', doors: [], countedMatchIds: [] });
    const doors = buildInsightDoors({ insight, subjectPath: identitySubjectPath });
    expect(doors.some((d) => d.kind === 'games')).toBe(false);
    expect(doors).toHaveLength(0);
  });

  it('a template with BOTH countedMatchIds and its own fallback door gets the games door FIRST, then the fallback', () => {
    const insight = makeInsight({
      templateId: 'secondaryPayoff',
      doors: [{ kind: 'matchup', axes: { fighter: 9, vs: 2 }, count: 5 }],
      countedMatchIds: ['s1', 's2', 's3', 's4', 's5'],
    });
    const doors = buildInsightDoors({ insight, subjectPath: identitySubjectPath });
    expect(doors).toHaveLength(2);
    expect(doors[0]!.kind).toBe('games');
    expect(doors[0]!.count).toBe(5);
    expect(doors[1]!.kind).toBe('matchup');
    expect(doors[1]!.href.startsWith('/matchups')).toBe(true);
  });

  const fallbackOnlyCases: Array<{
    templateId: InsightTemplateId;
    doors: InsightDoor[];
    expectedKind: string | undefined;
    expectedRoute?: string;
  }> = [
    {
      templateId: 'matchupOrPlayer',
      doors: [{ kind: 'opponent', axes: { fighter: 8, vs: 2 }, count: 3 }],
      expectedKind: 'opponent',
      expectedRoute: '/matchups',
    },
    { templateId: 'pocketCost', doors: [], expectedKind: undefined },
  ];

  it.each(fallbackOnlyCases)(
    'with countedMatchIds empty, $templateId gets exactly its named fallback door (or none), never a counted-games door',
    ({ templateId, doors, expectedKind, expectedRoute }) => {
      const insight = makeInsight({ templateId, doors, countedMatchIds: [] });
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

  describe('T-39.1-26 (gap closure): carry preserves host context, drops filter axes', () => {
    it('with no carry, the games door href is byte-identical to the pre-carry builder', () => {
      const insight = makeInsight({ templateId: 'formNow', countedMatchIds: ['a'] });
      const doors = buildInsightDoors({ insight, subjectPath: identitySubjectPath });
      expect(doors[0]!.href).toBe('?claim=formNow%3Aaccount%3Alast30#games');
    });

    it('a carry of fighter=1 and vs=5 with an anchor override keeps those params, sets the insight claim, and ends with the anchor', () => {
      const insight = makeInsight({ templateId: 'matchupOrPlayer', countedMatchIds: ['a', 'b'] });
      const carry = new URLSearchParams({ fighter: '1', vs: '5' });
      const doors = buildInsightDoors({
        insight,
        subjectPath: identitySubjectPath,
        anchor: '#matchup-table',
        carry,
      });
      expect(doors[0]!.kind).toBe('games');
      expect(doors[0]!.href).toContain('fighter=1');
      expect(doors[0]!.href).toContain('vs=5');
      expect(doors[0]!.href).toContain('claim=matchupOrPlayer%3Aaccount%3Alast30');
      expect(doors[0]!.href).toMatch(/#matchup-table$/);
    });

    it('a carry holding stage/event/from/to and a foreign claim never lets any of them survive — the claim is always the insight own id', () => {
      const insight = makeInsight({ templateId: 'formNow', countedMatchIds: ['a'] });
      const carry = new URLSearchParams({
        fighter: '1',
        stage: '3',
        event: 'evt',
        from: '100',
        to: '200',
        claim: 'someone-elses-claim',
      });
      const doors = buildInsightDoors({ insight, subjectPath: identitySubjectPath, carry });
      const href = doors[0]!.href;
      expect(href).toContain('fighter=1');
      expect(href).not.toContain('stage=');
      expect(href).not.toContain('event=');
      expect(href).not.toContain('from=');
      expect(href).not.toContain('to=');
      expect(href).not.toContain('someone-elses-claim');
      expect(href).toContain('claim=formNow%3Aaccount%3Alast30');
    });

    it('fallback doors are unaffected by carry', () => {
      const insight = makeInsight({
        templateId: 'matchupOrPlayer',
        doors: [{ kind: 'opponent', axes: { fighter: 8, vs: 2 }, count: 3 }],
        countedMatchIds: [],
      });
      const carry = new URLSearchParams({ fighter: '1', vs: '5' });
      const doors = buildInsightDoors({ insight, subjectPath: identitySubjectPath, carry });
      expect(doors).toHaveLength(1);
      expect(doors[0]!.kind).toBe('opponent');
    });
  });

  it('no second URL-building helper exists — every href funnels through buildDrillDownSearch', () => {
    const declarations = SOURCE_WITHOUT_COMMENTS.match(/function build\w*Search\s*\(/g) ?? [];
    expect(declarations).toHaveLength(0);
  });

  it('no door handler mutates persisted state — buildInsightDoors never touches storage', () => {
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem');
    const insight = makeInsight({
      templateId: 'secondaryPayoff',
      doors: [{ kind: 'matchup', axes: { fighter: 9, vs: 2 }, count: 5 }],
      countedMatchIds: ['s1'],
    });
    buildInsightDoors({
      insight: makeInsight({ templateId: 'formNow', countedMatchIds: ['a'] }),
      subjectPath: identitySubjectPath,
    });
    buildInsightDoors({ insight, subjectPath: identitySubjectPath });
    expect(setItemSpy).not.toHaveBeenCalled();
    setItemSpy.mockRestore();
  });
});

describe('resolveInsightClaim', () => {
  it('returns exactly the counted matches, in countedMatchIds own recorded order', () => {
    const a = makeMatch({ id: 'a', time: NOW_MS - ONE_HOUR_MS });
    const b = makeMatch({ id: 'b', time: NOW_MS - 2 * ONE_HOUR_MS });
    const outOfScope = makeMatch({ id: 'c', time: NOW_MS - 100 * ONE_HOUR_MS });
    const insight = makeInsight({ templateId: 'formNow', countedMatchIds: ['a', 'b'] });
    // matches array is deliberately in the OPPOSITE order from countedMatchIds,
    // and includes an id NOT in countedMatchIds at all — proving the resolver
    // follows countedMatchIds' own order, not `matches`' order.
    const resolved = resolveInsightClaim({
      claimId: insight.id,
      insights: [insight],
      matches: [outOfScope, b, a],
    });
    expect(resolved).toEqual([a, b]);
  });

  it('an id in countedMatchIds absent from the loaded matches array is silently skipped, never thrown', () => {
    const a = makeMatch({ id: 'a' });
    const insight = makeInsight({ templateId: 'formNow', countedMatchIds: ['a', 'stale-id'] });
    expect(() =>
      resolveInsightClaim({ claimId: insight.id, insights: [insight], matches: [a] }),
    ).not.toThrow();
    const resolved = resolveInsightClaim({
      claimId: insight.id,
      insights: [insight],
      matches: [a],
    });
    expect(resolved).toEqual([a]);
  });

  it('returns undefined for an unknown/stale claim id, never throws', () => {
    expect(() =>
      resolveInsightClaim({ claimId: 'nope:account:last30', insights: [], matches: [] }),
    ).not.toThrow();
    expect(
      resolveInsightClaim({ claimId: 'nope:account:last30', insights: [], matches: [] }),
    ).toBeUndefined();
  });

  it('a crafted claim id never throws', () => {
    const crafted = '<script>alert(1)</script>:../../etc/passwd';
    expect(() =>
      resolveInsightClaim({ claimId: crafted, insights: [], matches: [makeMatch()] }),
    ).not.toThrow();
  });

  it('an insight with an EMPTY countedMatchIds resolves to undefined — the resolver never fabricates a games set it cannot prove', () => {
    const insight = makeInsight({ templateId: 'tiltCost', doors: [], countedMatchIds: [] });
    const resolved = resolveInsightClaim({
      claimId: insight.id,
      insights: [insight],
      matches: [makeMatch()],
    });
    expect(resolved).toBeUndefined();
  });

  it('the resolver narrows within the already-loaded array only — never widens beyond it (elevation-of-privilege guard)', () => {
    const loaded = makeMatch({ id: 'loaded', time: NOW_MS });
    const insight = makeInsight({ templateId: 'formNow', countedMatchIds: ['loaded', 'phantom'] });
    const resolved = resolveInsightClaim({
      claimId: insight.id,
      insights: [insight],
      matches: [loaded],
    });
    expect(resolved).toEqual([loaded]);
    expect(resolved!.every((m) => [loaded].includes(m))).toBe(true);
  });

  it('the tied-timestamp fixture from 39.1-19: exact by construction — no trim needed, since countedMatchIds already names the one intended game', () => {
    const tieMs = NOW_MS;
    const newest = makeMatch({ id: 'newest', time: tieMs, win: true });
    const tiedExtra = makeMatch({ id: 'tied-extra', time: tieMs, win: false });
    // PRE-39.1-22 context: a naive [fromMs, toMs] reconstruction over an
    // inclusive tied boundary would return BOTH games (2), not the one the
    // card actually meant — the over-count UI-SPEC §13.13 named. Recorded
    // here as documentation of what countedMatchIds now makes unnecessary.
    const naiveCandidateCount = [newest, tiedExtra].filter(
      (m) => m.time >= tieMs && m.time <= tieMs,
    ).length;
    expect(naiveCandidateCount).toBe(2);

    // POST-39.1-22: countedMatchIds names exactly ONE id — no reconstruction,
    // no ambiguity, no trim.
    const insight = makeInsight({
      templateId: 'formNow',
      window: { horizon: 'last30', fromMs: tieMs, toMs: tieMs, games: 1, scoped: false },
      doors: [{ kind: 'games', axes: {}, count: 1 }],
      countedMatchIds: ['newest'],
    });
    const resolved = resolveInsightClaim({
      claimId: insight.id,
      insights: [insight],
      matches: [newest, tiedExtra],
    });
    expect(resolved).toEqual([newest]);
  });
});
