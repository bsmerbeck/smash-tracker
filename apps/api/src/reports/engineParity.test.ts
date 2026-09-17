import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildMatchupEvidence,
  rankMatchupsByEvidence,
  rankStagesByEvidence,
  wilsonLowerBound,
  type Match,
} from '@smash-tracker/shared';

/**
 * EVID-10 web/API parity (D-14, plan 36-03 Task 3). This is NOT a test of
 * `rankStagesByEvidence`/`rankMatchupsByEvidence`/`buildMatchupEvidence`'s
 * own math (that's `packages/shared/src/evidence/*.test.ts`'s job). It is a
 * test that the API tier and the web tier are STRUCTURALLY guaranteed to
 * compute IDENTICAL evidence output, proven two ways:
 *
 * 1. This file calls the three functions through `@smash-tracker/shared`
 *    (the API's own import path) over one deterministic fixture and asserts
 *    the result deep-equals a LITERAL expected object declared right here —
 *    never a vitest auto-snapshot file, which would silently update itself
 *    on a regression and stop proving anything (only the Wilson lower bound
 *    itself, a well-tested pure-math primitive, is computed via the
 *    imported `wilsonLowerBound` rather than hand-typed as a float literal —
 *    every other field, and the ranked ORDER, is a hardcoded literal).
 * 2. `apps/web/src/lib/stats.ts` (the web tier's own name for this same
 *    surface, per its own module doc comment) is scanned ON DISK: each
 *    parity-tested name must NOT be locally declared there (no local
 *    `function`/`const`/`let`/`var` re-implementation) and MUST be
 *    re-exported via an `export { ... } from '@smash-tracker/shared'`
 *    clause — i.e. the web tier's own copy of these names is provably a
 *    re-export of the exact same implementation this file just exercised,
 *    not a second implementation that merely happens to agree today. A
 *    future reinstatement of a local body for any of these three names in
 *    `stats.ts` makes this suite red (verified manually — see 36-03-SUMMARY.md
 *    for the observed failing output).
 */

const REPO_ROOT = resolve(process.cwd(), '..', '..');
const STATS_SHIM_PATH = resolve(REPO_ROOT, 'apps/web/src/lib/stats.ts');
const GENERATE_TS_PATH = resolve(process.cwd(), 'src/reports/generate.ts');

const PARITY_NAMES = [
  'rankStagesByEvidence',
  'rankMatchupsByEvidence',
  'buildMatchupEvidence',
] as const;

/** Strips `//` and `/* *\/` comments so a comment-only mention never satisfies either check below. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

// ---------------------------------------------------------------------------
// 1. Literal-fixture parity proof
// ---------------------------------------------------------------------------

/**
 * One deterministic fixture: two opponent fighters (8, 22), two known
 * stages (1, 3), each combination carrying exactly 2 wins / 1 loss / 3
 * total games — deliberately symmetric so the stage axis and the
 * matchup axis produce the SAME shape (a genuine coincidence of this
 * fixture's numbers, not a property the functions themselves share), which
 * keeps this file's literal expected values simple without weakening what
 * they prove: floor gating at exactly the D-05 floor (3), Wilson-tie
 * ordering by ascending key, and the shared `sample`/`cohort` shape.
 *
 * `opponent`/alias-shaped fields are populated (a real report payload would
 * carry them) even though none of the three parity-tested functions read
 * `match.opponent` for grouping (`rankStagesByEvidence`/
 * `rankMatchupsByEvidence`/`buildMatchupEvidence` all group on `map.id`/
 * `opponent_id`, never on the free-text tag — see their own doc comments in
 * `packages/shared/src/evidence/stageEvidence.ts` /`matchupEvidence.ts`) —
 * present here only so the fixture reads like a real match record, not a
 * claim that alias resolution is in scope for this file.
 */
const ALIAS_MAP: Record<string, string> = { 'sponsor tag': 'rival' };

const FIXTURE: Match[] = [
  {
    id: 'm1',
    fighter_id: 1,
    opponent_id: 8,
    time: 1000,
    win: true,
    map: { id: 1, name: 'Battlefield' },
    opponent: 'rival',
  },
  {
    id: 'm2',
    fighter_id: 1,
    opponent_id: 8,
    time: 2000,
    win: false,
    map: { id: 1, name: 'Battlefield' },
    opponent: 'rival',
  },
  {
    id: 'm3',
    fighter_id: 1,
    opponent_id: 8,
    time: 3000,
    win: true,
    map: { id: 3, name: 'Final Destination' },
    // Resolves to the same identity as 'rival' via ALIAS_MAP — irrelevant to
    // the three functions under test (they don't group on this field), kept
    // to document that fact rather than to exercise it.
    opponent: 'sponsor tag',
  },
  {
    id: 'm4',
    fighter_id: 1,
    opponent_id: 22,
    time: 4000,
    win: true,
    map: { id: 1, name: 'Battlefield' },
    opponent: 'someone',
  },
  {
    id: 'm5',
    fighter_id: 1,
    opponent_id: 22,
    time: 5000,
    win: true,
    map: { id: 3, name: 'Final Destination' },
    opponent: 'someone',
  },
  {
    id: 'm6',
    fighter_id: 1,
    opponent_id: 22,
    time: 6000,
    win: false,
    map: { id: 3, name: 'Final Destination' },
    opponent: 'someone',
  },
];

/** Every ranked row in this fixture shares the same 2W/1L/3-total shape, so they share the same Wilson lower bound. */
const WILSON_2_OF_3 = wilsonLowerBound(2, 3);

describe('EVID-10 engine parity — literal-fixture proof (D-14)', () => {
  it('self-check: the fixture is non-empty (anti-vacuous-pass guard)', () => {
    expect(FIXTURE.length).toBeGreaterThan(0);
    expect(Object.keys(ALIAS_MAP).length).toBeGreaterThan(0);
  });

  it('rankStagesByEvidence: two known stages, each at exactly the D-05 floor, ordered by ascending stageId on a Wilson tie', () => {
    expect(rankStagesByEvidence(FIXTURE)).toEqual([
      { stageId: 1, wins: 2, losses: 1, total: 3, winRate: 67, wilson: WILSON_2_OF_3 },
      { stageId: 3, wins: 2, losses: 1, total: 3, winRate: 67, wilson: WILSON_2_OF_3 },
    ]);
  });

  it('rankMatchupsByEvidence: two opponent fighters, each at exactly the D-05 floor, ordered by ascending opponentFighterId on a Wilson tie', () => {
    expect(rankMatchupsByEvidence(FIXTURE)).toEqual([
      {
        opponentFighterId: 8,
        wins: 2,
        losses: 1,
        totalMatches: 3,
        ratio: 67,
        wilson: WILSON_2_OF_3,
      },
      {
        opponentFighterId: 22,
        wins: 2,
        losses: 1,
        totalMatches: 3,
        ratio: 67,
        wilson: WILSON_2_OF_3,
      },
    ]);
  });

  it('buildMatchupEvidence: evidenced claim carrying the ranked value, a null unknown bucket, and the sample/cohort shape', () => {
    const REFRESHED_AT = 1_700_000_000_000;
    expect(buildMatchupEvidence({ matches: FIXTURE, refreshedAt: REFRESHED_AT })).toEqual({
      claim: {
        kind: 'evidenced',
        claimType: 'inference',
        value: [
          {
            opponentFighterId: 8,
            wins: 2,
            losses: 1,
            totalMatches: 3,
            ratio: 67,
            wilson: WILSON_2_OF_3,
          },
          {
            opponentFighterId: 22,
            wins: 2,
            losses: 1,
            totalMatches: 3,
            ratio: 67,
            wilson: WILSON_2_OF_3,
          },
        ],
        sample: {
          rawSampleSize: 6,
          eligibleDenominator: 6,
          knownFieldCoverage: 1,
          dateRange: { firstMs: 1000, lastMs: 6000 },
          refreshedAt: REFRESHED_AT,
          evidencePolicyVersion: 1,
          recencyTreatment: 'unweighted',
          confidenceTier: 'low',
        },
      },
      unknown: null,
      cohort: {
        online: 0,
        offline: 0,
        unspecified: 6,
        manual: 6,
        startgg: 0,
        parrygg: 0,
        mixedContext: false,
        minorityShare: 0,
        minorityLabel: null,
        majorityLabel: null,
      },
    });
  });
});

// ---------------------------------------------------------------------------
// 2. Structural no-second-implementation proof (stats.ts shim scan)
// ---------------------------------------------------------------------------

describe('EVID-10 engine parity — apps/web/src/lib/stats.ts has no local re-implementation (D-14)', () => {
  it('self-check: the shim file was found and is non-empty (anti-vacuous-pass guard)', () => {
    const source = readFileSync(STATS_SHIM_PATH, 'utf-8');
    expect(source.length).toBeGreaterThan(0);
  });

  it.each(PARITY_NAMES)(
    '%s: no local declaration in stats.ts, and it IS re-exported from @smash-tracker/shared',
    (name) => {
      const source = stripComments(readFileSync(STATS_SHIM_PATH, 'utf-8'));

      // No local re-implementation under this name.
      const localDeclarationPattern = new RegExp(`\\b(function|const|let|var)\\s+${name}\\b`);
      expect(localDeclarationPattern.test(source)).toBe(false);

      // The name IS re-exported from the shared engine — i.e. whatever
      // apps/web calls under this name is exactly the same function
      // apps/api just exercised above, not a second implementation that
      // merely happens to agree today.
      const exportFromBlocks = [
        ...source.matchAll(/export\s*\{([^}]*)\}\s*from\s*['"]@smash-tracker\/shared['"]/g),
      ];
      const namesInExportFromBlocks = new Set(
        exportFromBlocks.flatMap((match) =>
          (match[1] ?? '')
            .split(',')
            .map((entry) =>
              entry
                .trim()
                .split(/\s+as\s+/)[0]
                ?.trim(),
            )
            .filter((entry): entry is string => Boolean(entry)),
        ),
      );
      expect(namesInExportFromBlocks.has(name)).toBe(true);
    },
  );
});

// ---------------------------------------------------------------------------
// 3. SYSTEM_PROMPT reads structured claim fields, not a prose sample-size
//    rule of its own (D-11, D-14) — the TDD RED target for this task.
// ---------------------------------------------------------------------------

/**
 * Extracts the `SYSTEM_PROMPT` template literal body from `generate.ts`'s
 * own source on disk — mirrors this plan's own `<verify>` node-guard
 * commands exactly (SYSTEM_PROMPT is a module-private `const`, never
 * exported, by design: the prompt text is an implementation detail, not a
 * public API of this module).
 */
function extractSystemPrompt(): string {
  const source = readFileSync(GENERATE_TS_PATH, 'utf-8');
  const match = /const SYSTEM_PROMPT = `([\s\S]*?)`;/.exec(source);
  if (!match) {
    throw new Error('SYSTEM_PROMPT not found in generate.ts');
  }
  return match[1] ?? '';
}

describe('EVID-10 engine parity — SYSTEM_PROMPT reads claim fields, not a prose threshold (D-11, D-14)', () => {
  it('self-check: SYSTEM_PROMPT was found and is non-empty (anti-vacuous-pass guard)', () => {
    expect(extractSystemPrompt().length).toBeGreaterThan(0);
  });

  it('contains no hard-coded "fewer than <N> games" sample-size construction', () => {
    const prompt = extractSystemPrompt();
    const hardCodedThresholds = [...prompt.matchAll(/fewer than \d+/g)].map((m) => m[0]);
    expect(hardCodedThresholds).toEqual([]);
  });

  it('names evidencePolicy.abstentionFloorGames as the one sample threshold in play', () => {
    expect(extractSystemPrompt()).toContain('evidencePolicy.abstentionFloorGames');
  });

  it('still contains the ground-every-claim, verbatim-names, and schema-conformance hard rules, unedited', () => {
    const prompt = extractSystemPrompt();
    expect(prompt).toContain('Ground every claim in the provided JSON payload ONLY');
    expect(prompt).toContain('come VERBATIM from the data provided');
    expect(prompt).toContain('Output must conform to the provided JSON schema exactly');
  });

  it('describes the matchupAdvisor abstained arm explicitly', () => {
    expect(extractSystemPrompt().toLowerCase()).toContain('abstained');
  });

  it('never instructs the model to state a bare win-probability percentage', () => {
    expect(extractSystemPrompt()).toContain('never state a bare win-probability percentage');
  });
});
