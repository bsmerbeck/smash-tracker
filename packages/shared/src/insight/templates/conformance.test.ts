import { describe, expect, it } from 'vitest';
import { INSIGHT_TEMPLATES } from './registry.js';
import { CORE_TEMPLATES } from './core.js';
import { SUBJECT_TEMPLATES } from './subject.js';
import { COHORT_TEMPLATES } from './cohort.js';
import { ROSTER_TEMPLATES } from './roster.js';
import type { InsightTemplate } from './registry.js';
import { computeInsights } from '../engine.js';
import { assembleRail } from '../rail.js';
import { ACCOUNT_SCOPE } from '../types.js';
import type {
  Insight,
  InsightKind,
  InsightScope,
  InsightState,
  InsightTemplateId,
} from '../types.js';
import type { Match } from '../../match.js';
import {
  emptyWorkspace,
  oneGameWorkspace,
  twoGameWorkspace,
  unknownStageOnlyWorkspace,
  unknownCharacterOnlyWorkspace,
  generateSyntheticMatches,
  EIGHT_K_FIXTURE_OPTIONS,
} from '../../testUtils/index.js';

/**
 * Phase 39.1's main honesty proof (INS-04, INS-05): ONE suite that iterates
 * `INSIGHT_TEMPLATES` itself — the composed, closed registry — rather than
 * naming templates by hand, so a template added later without a designed
 * thin-data result fails this suite automatically. Mirrors
 * `evidence/abstentionFixtures.test.ts`'s assertion style (plan 36-xx) and
 * `engine.test.ts`'s own FIXT-02 conformance describe block (plan 39.1-01),
 * generalized to every one of the 17 registered templates instead of the
 * whole-registry aggregate.
 */

const NOW_MS = 1_700_100_000_000;
/** Matches `sparseWorkspaces.ts`'s own `KNOWN_FIGHTER_ID` and `characterMovers.test.ts`'s `SUBJECT_FIGHTER_ID` convention. */
const SUBJECT_FIGHTER_ID = 8;

function characterScope(fighterId: number = SUBJECT_FIGHTER_ID): InsightScope {
  return {
    kind: 'character',
    key: `character:${fighterId}`,
    axes: { fighter: fighterId },
    filter: (matches) => matches.filter((m) => m.fighter_id === fighterId),
  };
}

/** The scope a template's own declared `scopeKind` is meaningfully invoked at — every template in the closed registry is EITHER account- or character-scoped today (D-09 discipline: the caller supplies scope identity, never the engine). */
function scopeFor(template: InsightTemplate): InsightScope {
  return template.scopeKind === 'character' ? characterScope() : ACCOUNT_SCOPE;
}

const NON_ASSERTIVE_STATES: readonly InsightState[] = [
  'fact',
  'steady',
  'thin',
  'thinRecent',
  'locked',
  'collapsed',
  'hidden',
];
const ALL_STATES: readonly InsightState[] = [...NON_ASSERTIVE_STATES, 'trend', 'suggestion'];

/** UI-SPEC §7.8's honesty ladder, restated as a kind-per-state table (D-11: the ENGINE sets `kind`, never a template directly) — the table assertion 4 asserts against, rather than re-running `classify`. */
const EXPECTED_KIND_BY_STATE: Record<InsightState, InsightKind> = {
  trend: 'inference',
  suggestion: 'recommendation',
  fact: 'fact',
  steady: 'fact',
  thin: 'fact',
  thinRecent: 'fact',
  locked: 'fact',
  collapsed: 'fact',
  hidden: 'fact',
};

const COPY_KEY_PATTERN = /^insights\.[a-zA-Z]+\./;
/** A generous ceiling above every real static/short token this codebase's templates emit today (the longest fighter name, "Mr. Game & Watch", is 16 chars; `tiltCost.ts`'s static `cue: 'after 2 straight losses'` is 23) — well below anything resembling an assembled, interpolated sentence. */
const MAX_COPY_VALUE_STRING_LENGTH = 40;

/**
 * UI-SPEC §13.13a's non-window-expressible list, review finding C1-H2 plus
 * CR-A05 (`settingGap` added — a same-scope matchType PARTITION, not a
 * contiguous window; `DrillDownAxes` has no online/offline axis to
 * reconstruct it from): the seven templates whose games are a non-contiguous
 * subset or an unexpressible partition (post-streak spots, in-session
 * buckets, high-volume months, a pooled pocket group, a main-vs-secondary
 * pairing, one opponent's share of losses, an online/offline split). Named
 * here ONCE, used only to cross-check the MEASURED split below — never to
 * skip a template inside the iteration loops (every assertion loop below
 * iterates `INSIGHT_TEMPLATES` unconditionally).
 */
const DOCUMENTED_NON_WINDOW_EXPRESSIBLE_IDS: readonly InsightTemplateId[] = [
  'tiltCost',
  'sessionFatigue',
  'volumeForm',
  'secondaryPayoff',
  'pocketCost',
  'matchupOrPlayer',
  'settingGap',
];

const THIN_FIXTURES: ReadonlyArray<readonly [string, () => Match[]]> = [
  ['emptyWorkspace', emptyWorkspace],
  ['oneGameWorkspace', oneGameWorkspace],
  ['twoGameWorkspace', twoGameWorkspace],
  ['unknownStageOnlyWorkspace', unknownStageOnlyWorkspace],
  ['unknownCharacterOnlyWorkspace', unknownCharacterOnlyWorkspace],
];

/** Matches `engine.test.ts`'s own precedent (plan 39.1-01): a deliberately thin ~40-game realistic-shaped fixture, distinct from the hand-shaped FIXT-02 fixtures above. */
function buildDeliberatelyThin40GameFixture(): Match[] {
  return generateSyntheticMatches({ seed: 40, count: 40 });
}

function buildEightKFixture(): Match[] {
  return generateSyntheticMatches(EIGHT_K_FIXTURE_OPTIONS);
}

interface ResultEntry {
  templateId: InsightTemplateId;
  fixtureName: string;
  insight: Insight;
}

const ALL_FIXTURES: ReadonlyArray<readonly [string, () => Match[]]> = [
  ...THIN_FIXTURES,
  ['deliberatelyThin40Games', buildDeliberatelyThin40GameFixture],
  ['eightK', buildEightKFixture],
];

/** Runs every registered template, at its own scope kind, over every fixture in `ALL_FIXTURES` — the one place this suite actually calls `.build()`. */
function collectAllResults(): ResultEntry[] {
  const entries: ResultEntry[] = [];
  for (const [fixtureName, buildFixture] of ALL_FIXTURES) {
    const matches = buildFixture();
    for (const template of INSIGHT_TEMPLATES) {
      const results = template.build({
        matches,
        scope: scopeFor(template),
        horizon: 'last30',
        nowMs: NOW_MS,
      });
      for (const insight of results) {
        entries.push({ templateId: template.id, fixtureName, insight });
      }
    }
  }
  return entries;
}

const TEMPLATE_BY_ID = new Map<InsightTemplateId, InsightTemplate>(
  INSIGHT_TEMPLATES.map((t) => [t.id, t]),
);

describe('assertion 1: closed set', () => {
  it('INSIGHT_TEMPLATES has no duplicate ids, and its length equals the union of the four segments', () => {
    const ids = INSIGHT_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(INSIGHT_TEMPLATES.length).toBe(
      CORE_TEMPLATES.length +
        SUBJECT_TEMPLATES.length +
        COHORT_TEMPLATES.length +
        ROSTER_TEMPLATES.length,
    );
  });

  it('MEASURES the registry length at 17 (recorded in the SUMMARY, not recalled)', () => {
    expect(INSIGHT_TEMPLATES.length).toBe(17);
  });
});

describe('assertion 2/3: thin-data conformance and never an empty frame', () => {
  const thinFixtureNames = new Set([
    ...THIN_FIXTURES.map(([name]) => name),
    'deliberatelyThin40Games',
  ]);
  const invokedTemplateIds = new Set<InsightTemplateId>();
  const thinResults: ResultEntry[] = [];

  for (const [fixtureName, buildFixture] of ALL_FIXTURES) {
    if (!thinFixtureNames.has(fixtureName)) continue;
    const matches = buildFixture();
    for (const template of INSIGHT_TEMPLATES) {
      invokedTemplateIds.add(template.id);
      const results = template.build({
        matches,
        scope: scopeFor(template),
        horizon: 'last30',
        nowMs: NOW_MS,
      });
      for (const insight of results) {
        thinResults.push({ templateId: template.id, fixtureName, insight });
      }
    }
  }

  it('every one of the 17 templates was actually invoked (coverage), proven by a per-template call tally', () => {
    expect(invokedTemplateIds.size).toBe(INSIGHT_TEMPLATES.length);
  });

  it('every result on every thin/sparse fixture has a non-assertive state and a null deltaPoints', () => {
    expect(thinResults.length).toBeGreaterThan(0);
    for (const { templateId, fixtureName, insight } of thinResults) {
      expect(insight, `${templateId} on ${fixtureName}`).toBeDefined();
      expect(ALL_STATES, `${templateId} on ${fixtureName}: unknown state`).toContain(insight.state);
      expect(
        NON_ASSERTIVE_STATES,
        `${templateId} on ${fixtureName} asserted ${insight.state}`,
      ).toContain(insight.state);
      expect(insight.deltaPoints, `${templateId} on ${fixtureName}`).toBeNull();
    }
  });

  it('no template returns undefined, an empty object, or a state outside InsightState', () => {
    for (const { templateId, fixtureName, insight } of thinResults) {
      expect(insight, `${templateId} on ${fixtureName}`).not.toBeUndefined();
      expect(typeof insight.state, `${templateId} on ${fixtureName}`).toBe('string');
      expect(ALL_STATES, `${templateId} on ${fixtureName}`).toContain(insight.state);
    }
  });
});

describe('INS-04: deltaPoints is null outside the trend/suggestion states, across every fixture (not thin-only)', () => {
  it('holds for every result this suite ever produced', () => {
    const all = collectAllResults();
    expect(all.length).toBeGreaterThan(0);
    for (const { templateId, fixtureName, insight } of all) {
      if (insight.state !== 'trend' && insight.state !== 'suggestion') {
        expect(
          insight.deltaPoints,
          `${templateId} on ${fixtureName} (state ${insight.state})`,
        ).toBeNull();
      }
    }
  });
});

describe('assertion 4: kind is set by the ladder', () => {
  it("every result's kind matches the honesty-ladder table for its state", () => {
    const all = collectAllResults();
    for (const { templateId, fixtureName, insight } of all) {
      expect(insight.kind, `${templateId} on ${fixtureName} (state ${insight.state})`).toBe(
        EXPECTED_KIND_BY_STATE[insight.state],
      );
    }
  });
});

describe('assertion 5: copy is a key path, not a sentence', () => {
  it('every copy.key matches ^insights\\.[a-zA-Z]+\\. and every copy.values entry is a short primitive', () => {
    const all = collectAllResults();
    expect(all.length).toBeGreaterThan(0);
    for (const { templateId, fixtureName, insight } of all) {
      expect(insight.copy.key, `${templateId} on ${fixtureName}`).toMatch(COPY_KEY_PATTERN);
      for (const [valueKey, value] of Object.entries(insight.copy.values)) {
        const label = `${templateId} on ${fixtureName}: copy.values.${valueKey}`;
        expect(typeof value === 'string' || typeof value === 'number', label).toBe(true);
        if (typeof value === 'string') {
          expect(value.length, `${label} ("${value}")`).toBeLessThanOrEqual(
            MAX_COPY_VALUE_STRING_LENGTH,
          );
        }
      }
    }
  });
});

describe('assertion 6: doors are honest', () => {
  it('every registered template declares windowExpressible as a boolean', () => {
    for (const template of INSIGHT_TEMPLATES) {
      expect(typeof template.windowExpressible, template.id).toBe('boolean');
    }
  });

  it('DOCUMENTATION ONLY: windowExpressible metadata still names the same seven ids as non-expressible (it no longer decides door behavior — see the countedMatchIds invariant below)', () => {
    const falseIds = INSIGHT_TEMPLATES.filter((t) => t.windowExpressible === false)
      .map((t) => t.id)
      .sort();
    expect(falseIds).toEqual([...DOCUMENTED_NON_WINDOW_EXPRESSIBLE_IDS].sort());
  });

  it(
    'plan 39.1-22: every template records countedMatchIds on every result — the new door-' +
      'predicate invariant, REPLACING the old windowExpressible 10/7 split measurement. ' +
      'windowExpressible remains DOCUMENTATION metadata (asserted as a boolean above) but is ' +
      'no longer what decides whether a counted-games door is exact — see countedGames.test.ts ' +
      'for the full per-template exactness proof (duplicate-free, scope-honest, length === ' +
      'window.games).',
    () => {
      const all = collectAllResults();
      expect(all.length).toBeGreaterThan(0);
      for (const { templateId, fixtureName, insight } of all) {
        const label = `${templateId} on ${fixtureName}`;
        expect(Array.isArray(insight.countedMatchIds), label).toBe(true);
        expect(new Set(insight.countedMatchIds).size, `${label}: duplicate id`).toBe(
          insight.countedMatchIds.length,
        );
      }
    },
  );

  it('a template whose windowExpressible is false never emits a counted-games door', () => {
    const all = collectAllResults();
    let checkedNonExpressibleDoor = false;
    for (const { templateId, fixtureName, insight } of all) {
      const template = TEMPLATE_BY_ID.get(templateId)!;
      if (template.windowExpressible === false) {
        checkedNonExpressibleDoor = true;
        expect(
          insight.doors.some((door) => door.kind === 'games'),
          `${templateId} on ${fixtureName} emitted a counted-games door despite windowExpressible: false`,
        ).toBe(false);
      }
    }
    // Non-vacuity for THIS assertion: at least one non-expressible template
    // must have produced at least one result somewhere in the fixture set,
    // or the loop above never actually checked anything.
    expect(checkedNonExpressibleDoor).toBe(true);
  });
});

describe('assertion 7: non-vacuity — the 8k fixture', () => {
  it('at least one template returns a trend/suggestion state with a non-null deltaPoints', () => {
    const matches = buildEightKFixture();
    const results: ResultEntry[] = [];
    for (const template of INSIGHT_TEMPLATES) {
      const built = template.build({
        matches,
        scope: scopeFor(template),
        horizon: 'last30',
        nowMs: NOW_MS,
      });
      for (const insight of built) {
        results.push({ templateId: template.id, fixtureName: 'eightK', insight });
      }
    }
    expect(
      results.some(
        (r) =>
          (r.insight.state === 'trend' || r.insight.state === 'suggestion') &&
          r.insight.deltaPoints !== null,
      ),
    ).toBe(true);

    // Non-vacuity companion: every registered template produced at least one
    // result on the 8k fixture (measured — no template returned an empty
    // array here), so the thin-data assertions above cannot be vacuously
    // true because every template returned nothing everywhere.
    const producingTemplateIds = new Set(results.map((r) => r.templateId));
    expect(producingTemplateIds.size).toBe(INSIGHT_TEMPLATES.length);
  });

  it('deliberately emptying the 8k fixture makes the non-vacuity check above fail (the proven failing case)', () => {
    const matches: Match[] = [];
    const results: ResultEntry[] = [];
    for (const template of INSIGHT_TEMPLATES) {
      const built = template.build({
        matches,
        scope: scopeFor(template),
        horizon: 'last30',
        nowMs: NOW_MS,
      });
      for (const insight of built) {
        results.push({ templateId: template.id, fixtureName: 'empty', insight });
      }
    }
    // With zero matches, every template that asserts a direction returns
    // nothing (`lastEventRecap` is the one documented exception — DD-02's
    // "hidden, never locked/empty" degrade materializes a real `hidden`
    // Insight even over zero games — so this does not assert total
    // emptiness, only that the non-vacuity claim itself now fails).
    expect(
      results.some(
        (r) =>
          (r.insight.state === 'trend' || r.insight.state === 'suggestion') &&
          r.insight.deltaPoints !== null,
      ),
    ).toBe(false);
  });
});

describe('assertion 8: rail integration', () => {
  it('assembleRail(computeInsights(...)) over each sparse workspace returns at least one card and zero cards with a non-null deltaPoints', () => {
    for (const [, buildFixture] of THIN_FIXTURES) {
      const matches = buildFixture();
      const insights = computeInsights({
        matches,
        scopes: [ACCOUNT_SCOPE],
        horizon: 'last30',
        nowMs: NOW_MS,
      });
      const { cards } = assembleRail({ insights });
      expect(cards.length).toBeGreaterThanOrEqual(1);
      for (const card of cards) {
        expect(card.deltaPoints).toBeNull();
      }
    }
  });
});
