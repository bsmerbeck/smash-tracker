import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  buildClaimSet,
  CLAIM_PREDICATES,
  confidenceTierFor,
  type ClaimAtom,
  type ClaimPredicate,
  type EvidenceRow,
  buildMatchupEvidence,
  rankMatchupsByEvidence,
  rankStagesByEvidence,
  wilsonLowerBound,
  type Match,
  type ReportSurface,
  type ScoutReportData,
} from '@smash-tracker/shared';
import type { ParryggClients } from '../parrygg/client.js';
import { FakeDatabase } from '../test-support/fakeDatabase.js';
import { authHeader, buildTestApp, TEST_UID } from '../test-support/testApp.js';
import {
  seedViableEvidence,
  viableParryMatchesList,
} from '../test-support/viableEvidenceFixture.js';
import { assembleReportPayload, type AnthropicLikeClient } from './generate.js';

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

  // Phase 39 (plan 39-06 Task 3, AI-SPEC §4b): the instructional grounding
  // the three assertions below used to pin (a named sample threshold, a
  // "ground every claim" rule, a "state the tier" rule, a "no bare
  // percentage" rule) was DELETED, not kept alongside the structural version:
  // the model now receives engine-issued claims only and cannot author a
  // number the app displays. These assertions pin the replacement.

  it('names no sample threshold at all — the claims carry their own tiers and abstentions (no digit anywhere in the prompt)', () => {
    expect(extractSystemPrompt()).not.toMatch(/\d/);
  });

  it('states what the model is for — select and connect claims, never compute — and that only input ids may be used', () => {
    const prompt = extractSystemPrompt();
    expect(prompt).toContain('choose which claims matter most');
    expect(prompt).toContain('Do not compute, count, rank or estimate anything');
    expect(prompt).toContain('Use only claim ids and action ids that appear in the input');
    expect(prompt).toContain('display names those claims give');
  });

  it('describes the abstained claim value explicitly, as a gap rather than a finding', () => {
    expect(extractSystemPrompt()).toContain('"abstained" is a gap in the evidence');
  });

  it('never asks the model to state or hedge a confidence level (the retired instructional grounding)', () => {
    expect(extractSystemPrompt()).not.toMatch(/confidence|hedg|sample-size|percentage/i);
  });

  it('D-24: states UP FRONT that commentary is qualitative only and every figure lives in the claims, naming each withheld form', () => {
    const prompt = extractSystemPrompt();
    const rule = prompt.indexOf('qualitative commentary only');
    expect(rule).toBeGreaterThan(-1);
    expect(rule).toBeLessThan(prompt.indexOf('Your job is'));
    expect(prompt).toContain('Every figure the user sees comes from the claims');
    for (const form of [
      'no digits',
      'no number words',
      'no win-loss records or scores',
      'no percent signs',
      'low, medium, high, moderate, strong or weak',
      'is withheld from the user',
    ]) {
      expect(prompt, form).toContain(form);
    }
  });

  it('R5-CR-01 / R5-CR-03 (iteration 5): states English only and plain text with no Markdown emphasis, and names the extended withheld words, before the job', () => {
    const prompt = extractSystemPrompt();
    const rule = prompt.indexOf('Write in English only, in plain text');
    expect(rule).toBeGreaterThan(-1);
    expect(rule).toBeLessThan(prompt.indexOf('Your job is'));
    for (const form of [
      'no Markdown emphasis or code marks (no asterisks, underscores, tildes or backticks)',
      'no emoji',
      'an ampersand, a plus sign or any other symbol withholds the section too',
      'once, both, single, pair, couple, few, several, many, most, top, mid, max, poor, solid, sure, certain, reliable, shaky, undefeated, unbeaten, winless, swept or perfect record',
      '"remember to" rather than "make sure"',
    ]) {
      expect(prompt, form).toContain(form);
    }
  });

  it('R6-IN-05 / R6-WR-01 / R6-CR-04 (iteration 6): permits round or square brackets, and names the all-or-nothing words, letter spelling and lone letters as withheld', () => {
    const prompt = extractSystemPrompt();
    for (const form of [
      'round or square brackets',
      'every, all, each, never, always, only, even, split, tied, double, triple, lone, sole, solo or perfect',
      'spell a word out letter by letter',
      'a lone letter or a roman numeral as a label',
    ]) {
      expect(prompt, form).toContain(form);
    }
    expect(prompt).not.toContain('marks, brackets,');
  });
});

// ---------------------------------------------------------------------------
// 4. RPT-05 surface identity, API side (plan 39-06 Task 3)
// ---------------------------------------------------------------------------

/**
 * The API-side half of plan 39-03's surface-identity property: the claim set
 * produced from one fixed fixture is IDENTICAL whichever assembly entry point
 * produced the rows — `assembleReportPayload` for a legacy scout, the same
 * function for a prep single and a bundle child (its `surface` option), and a
 * direct `buildClaimSet` over the rows it emitted. The synthesis entry point
 * (`assembleSynthesisPayload`) joins this assertion in plan 39-08, when it
 * starts emitting `vod_annotation` rows through the same builder.
 */
describe('RPT-05 surface identity — the claim set is independent of the assembly entry point (plan 39-06)', () => {
  const SCOUT: ScoutReportData = {
    player: { id: 1, gamerTag: 'rival' },
    sampledSets: 10,
    sampledGames: 12,
    characters: [
      { fighterId: 8, games: 8, wins: 4 },
      { fighterId: 22, games: 4, wins: 2 },
    ],
    stages: [],
    recentEvents: [],
    commonOpponents: [],
  };

  async function assemble(surface: ReportSurface) {
    const database = new FakeDatabase();
    database.seed(
      'matches/uid',
      Object.fromEntries(FIXTURE.map(({ id, ...record }) => [id, record])),
    );
    database.seed('opponentAliases/uid', ALIAS_MAP);
    return assembleReportPayload(
      'uid',
      SCOUT,
      database as unknown as Parameters<typeof assembleReportPayload>[2],
      { surface },
    );
  }

  it('scout, prep_report and prep_bundle_child assemblies issue byte-identical claim sets, equal to buildClaimSet over the emitted rows', async () => {
    const scout = await assemble('scout');
    expect(scout.claimSet.claims.length).toBeGreaterThan(0);
    for (const surface of ['prep_report', 'prep_bundle_child'] as const) {
      const other = await assemble(surface);
      expect(Object.keys(other.rows)).toEqual(Object.keys(scout.rows));
      expect(stripRefreshedAt(other.claimSet)).toEqual(stripRefreshedAt(scout.claimSet));
    }
    expect(buildClaimSet({ rows: scout.rows, surface: 'post_event_synthesis' })).toEqual(
      scout.claimSet,
    );
  });
});

/** Two assemblies stamp their own wall-clock refresh time into every sample — compare everything else. */
function stripRefreshedAt(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (key, member) => (key === 'refreshedAt' ? undefined : member)),
  );
}

// ---------------------------------------------------------------------------
// 5. RPT-05 four-surface identity, at the ROUTE (plan 39-08 Task 3)
// ---------------------------------------------------------------------------

/**
 * The roadmap's RPT-05 success criterion — "identical claims receive
 * identical confidence treatment across every surface" — expressed as a
 * test. ONE deterministic, code-only fixture workspace (the plan 39-06
 * viable-evidence fixture, consumed unmodified, plus a hand-authored
 * three-game annotated event; no production data) is driven through all
 * FOUR submission branches of `POST /api/reports` with a stubbed model:
 * the legacy scout branch, `prep_report`, a `prep_bundle` child, and
 * `post_event_synthesis`. What is captured is the engine's ISSUE — the
 * claims each branch handed the model (off the stub's own call) and the
 * claims it stored (the stub selects every issued id, so the stored map IS
 * the issued set) — never the model's selection.
 *
 * What the four surfaces share, and why exactly that: the three scout
 * surfaces scout the SAME opponent (one parry.gg identity; the legacy query
 * is that profile's URL, the prep surfaces reach it through a binding whose
 * curated name is the canonical form of the scouted tag, so the binding
 * path's rule 4 and the legacy tag path select the same head-to-head
 * matches) and must issue BYTE-IDENTICAL claim sets. The synthesis surface
 * rests on annotated VOD moments ONLY (`MIN_VIABLE_CLAIMS` doc and the
 * RPT-08 rubric: "rests on annotation claims"; admitting the player-scoped
 * families there would let a plan citing no moment pass validation, which
 * the migration battery in `routes/reportsSynthesis.test.ts` shows would be
 * WEAKER than the rule it replaced), so it shares no predicate with them: its
 * whole predicate set is `vod_annotation`, a family no scout surface issues.
 * The block therefore compares PREDICATE SETS rather than exempting a
 * surface, proves the tier is one function of countable games across all
 * four, and proves a claim's content cannot depend on which surface issued
 * it by merging the surfaces' stored rows into ONE claim set.
 *
 * A future surface joining the pipeline must be ADDED to this block, never
 * exempted from it.
 */
describe('RPT-05 four-surface identity at the route: legacy scout, prep_report, prep_bundle child, post_event_synthesis (plan 39-08)', () => {
  const PARITY_PARRY_USER_ID = '019ce9ba-debd-7e11-84a2-77258f52644e';
  const PARITY_SCOUTED_TAG = 'Pandem1c';
  /** The curated opponent name: the canonical (lowercased) form of the scouted tag. */
  const PARITY_CURATED = 'pandem1c';
  const PARITY_BUNDLE = [PARITY_CURATED, 'parity-second', 'parity-third'];
  const PARITY_PREP_ENTRY = 'parity-prep-entry';
  const PARITY_REVIEW_ENTRY = 'parity-review-entry';
  const PARITY_EVENT_AT = 1_710_000_000_000;
  const PARITY_BINDING = {
    provider: 'parrygg',
    parryUserId: PARITY_PARRY_USER_ID,
    displayTag: PARITY_SCOUTED_TAG,
    method: 'matchHistory',
    confirmedAt: 1,
  };
  const CLEAN = {
    overview: 'Build around these.',
    gameplan: 'Drill the plan.',
    watchFor: 'Watch the habits.',
  };

  type Surface = 'legacy scout' | 'prep_report' | 'prep_bundle child' | 'post_event_synthesis';
  const SURFACES: readonly Surface[] = [
    'legacy scout',
    'prep_report',
    'prep_bundle child',
    'post_event_synthesis',
  ];

  interface ModelFacingView {
    id: string;
    predicate: ClaimPredicate;
    subject: ClaimAtom['subject'];
    value: ClaimAtom['value'];
    kind: ClaimAtom['claimKind'];
    tier: ClaimAtom['tier'];
    sample: { countableGames: number; totalGames: number };
  }

  interface SurfaceRun {
    issued: ModelFacingView[];
    stored: Record<string, Record<string, unknown>>;
    rows: Record<string, EvidenceRow>;
  }

  function parryClients(): ParryggClients {
    return {
      users: {
        getUser: vi.fn(async () => ({
          getUser: () => ({
            toObject: () => ({ id: PARITY_PARRY_USER_ID, gamerTag: PARITY_SCOUTED_TAG, bioMd: '' }),
          }),
        })),
        getUsers: vi.fn(async () => ({ getUsersList: () => [] })),
      } as unknown as ParryggClients['users'],
      matches: {
        getMatches: vi.fn(async () => ({
          getMatchesList: () => viableParryMatchesList(PARITY_PARRY_USER_ID),
        })),
      } as unknown as ParryggClients['matches'],
    };
  }

  /** The ONE fixture workspace, seeded identically into every surface's app. */
  function seedParityWorkspace(database: FakeDatabase): void {
    seedViableEvidence(database, TEST_UID, { opponentTag: PARITY_SCOUTED_TAG });
    // A three-game annotated event (three annotated games clear the floor).
    const moments: Array<[string, number, number, boolean]> = [
      ['parity-event-1', 40, 2, false],
      ['parity-event-2', 75, 8, true],
      ['parity-event-3', 12, 8, true],
    ];
    moments.forEach(([matchId, seconds, opponentId, win], index) => {
      database.seed(`matches/${TEST_UID}/${matchId}`, {
        fighter_id: 1,
        opponent_id: opponentId,
        time: PARITY_EVENT_AT + index * 60_000,
        win,
        eventName: 'Parity Invitational',
        source: 'startgg',
        opponent: 'eventfoe',
        vodTimestamps: [{ seconds, note: 'annotated moment' }],
      });
    });
    database.seed(`tournamentEntries/${TEST_UID}/${PARITY_REVIEW_ENTRY}`, {
      eventName: 'Parity Invitational',
      firstSetAt: PARITY_EVENT_AT,
      lastSetAt: PARITY_EVENT_AT + 3 * 60_000,
      setsPlayed: 3,
      source: 'manual',
    });
    database.seed(`prepBriefs/${TEST_UID}/${PARITY_REVIEW_ENTRY}`, {
      eventDate: PARITY_EVENT_AT,
      activatedAt: PARITY_EVENT_AT,
      lastOpenedAt: PARITY_EVENT_AT,
      reviewAt: PARITY_EVENT_AT,
    });
    database.seed(`prepBriefs/${TEST_UID}/${PARITY_PREP_ENTRY}`, {
      eventDate: PARITY_EVENT_AT,
      activatedAt: PARITY_EVENT_AT,
      lastOpenedAt: PARITY_EVENT_AT,
      likelyOpponents: Object.fromEntries(PARITY_BUNDLE.map((name) => [name, true])),
      scoutBindings: Object.fromEntries(PARITY_BUNDLE.map((name) => [name, PARITY_BINDING])),
    });
    database.seed(`credits/${TEST_UID}/balance`, 10);
  }

  /** Persisted snapshot rows back to engine rows: RTDB drops null members, so every nullable member is restored to `null`. */
  function restoreRows(
    stored: Record<string, Record<string, unknown>>,
  ): Record<string, EvidenceRow> {
    return Object.fromEntries(
      Object.entries(stored).map(([id, row]) => {
        const subject = (row.subject ?? {}) as Partial<ClaimAtom['subject']>;
        const sample = row.sample as EvidenceRow['sample'];
        return [
          id,
          {
            predicate: row.predicate as ClaimPredicate,
            subject: {
              myFighterId: subject.myFighterId ?? null,
              opponentFighterId: subject.opponentFighterId ?? null,
              stageId: subject.stageId ?? null,
              opponentTag: subject.opponentTag ?? null,
            },
            value: row.value as EvidenceRow['value'],
            sample: {
              ...sample,
              dateRange: sample.dateRange ?? null,
              confidenceTier: sample.confidenceTier ?? null,
            },
          },
        ];
      }),
    );
  }

  /** Drives ONE surface's submission branch on a fresh app over the shared fixture and captures its issue. */
  async function runSurface(surface: Surface): Promise<SurfaceRun> {
    const captured: { issued: ModelFacingView[] | null } = { issued: null };
    const modelSpy = vi.fn(async (params: unknown) => {
      const content = (params as { messages: Array<{ content: string }> }).messages[0]!.content;
      const issued = (JSON.parse(content) as { claims: ModelFacingView[] }).claims;
      captured.issued = issued;
      const ids = issued.map((claim) => claim.id);
      return {
        stop_reason: 'end_turn' as const,
        parsed_output: {
          // Every section cites every issued claim. (A section citing NO
          // claim is a separate, pre-existing defect on the scout 200
          // response — recorded in the phase's deferred-items.md by plan
          // 39-08 — and is not what this block measures.)
          sections: {
            overview: { claimIds: ids, connective: CLEAN.overview },
            gameplan: { claimIds: ids, connective: CLEAN.gameplan },
            watchFor: { claimIds: ids, connective: CLEAN.watchFor },
          },
          action1: null,
          action2: null,
          action3: null,
        },
      };
    });
    const { app, database } = buildTestApp({
      reports: { anthropicApiKey: 'sk-test-key', allowedUids: new Set(['someone-else']) },
      stripe: { secretKey: 'sk-test-123', webhookSecret: 'whsec-test-456' },
      prepPaid: { enabled: true },
      parrygg: { apiKey: 'parry-key' },
      parryggClients: parryClients(),
      reportsClient: { messages: { parse: modelSpy as AnthropicLikeClient['messages']['parse'] } },
    });
    seedParityWorkspace(database);
    const post = (payload: Record<string, unknown>) =>
      app.inject({ method: 'POST', url: '/api/reports', headers: authHeader(), payload });

    let response;
    if (surface === 'legacy scout') {
      response = await post({
        query: `https://parry.gg/profile/${PARITY_PARRY_USER_ID}`,
        jobId: 'parity-legacy',
      });
    } else if (surface === 'prep_report') {
      response = await post({
        reason: 'prep_report',
        entryKey: PARITY_PREP_ENTRY,
        opponentName: PARITY_CURATED,
        jobId: 'parity-prep',
      });
    } else if (surface === 'prep_bundle child') {
      const submit = await post({
        reason: 'prep_bundle',
        entryKey: PARITY_PREP_ENTRY,
        bundleId: 'parity-bundle',
        opponentNames: PARITY_BUNDLE,
      });
      expect(submit.statusCode).toBe(202);
      const child = (
        submit.json() as { jobs: Array<{ opponentName: string; jobId: string }> }
      ).jobs.find((job) => job.opponentName === PARITY_CURATED)!;
      response = await post({
        reason: 'prep_report',
        entryKey: PARITY_PREP_ENTRY,
        opponentName: child.opponentName,
        jobId: child.jobId,
      });
    } else {
      response = await post({ reason: 'post_event_synthesis', entryKey: PARITY_REVIEW_ENTRY });
    }

    expect(modelSpy, surface).toHaveBeenCalledTimes(1);
    expect([200, 202], `${surface} answered ${response.statusCode} ${response.body}`).toContain(
      response.statusCode,
    );
    const dump = database.dump() as Record<string, Record<string, Record<string, unknown>>>;
    const record: Record<string, unknown> =
      surface === 'post_event_synthesis'
        ? (Object.values(dump.practicePlans![TEST_UID]!)[0]! as Record<string, unknown>)
        : (Object.values(dump.scoutReports![TEST_UID]!)[0]! as { report: Record<string, unknown> })
            .report;
    const snapshots = Object.values(dump.evidenceSnapshots![TEST_UID]!) as Array<{
      rows: Record<string, Record<string, unknown>>;
    }>;
    expect(snapshots, surface).toHaveLength(1);
    return {
      issued: captured.issued!,
      stored: record.claims as Record<string, Record<string, unknown>>,
      rows: restoreRows(snapshots[0]!.rows),
    };
  }

  async function runAll(): Promise<Record<Surface, SurfaceRun>> {
    const runs = {} as Record<Surface, SurfaceRun>;
    for (const surface of SURFACES) {
      runs[surface] = await runSurface(surface);
    }
    return runs;
  }

  /** The shared-field projection the criterion compares: id, predicate, subject, value, kind, tier — plus the persisted policyVersion. */
  function sharedFields(run: SurfaceRun) {
    return run.issued.map((claim) => ({
      id: claim.id,
      predicate: claim.predicate,
      subject: claim.subject,
      value: claim.value,
      claimKind: claim.kind,
      tier: claim.tier,
      policyVersion: (run.stored[claim.id] as { policyVersion: number }).policyVersion,
    }));
  }

  function predicatesOf(run: SurfaceRun): Set<ClaimPredicate> {
    return new Set(run.issued.map((claim) => claim.predicate));
  }

  it('every surface issues a non-empty claim set and stores every issued claim (the capture is the engine’s issue, not a selection)', async () => {
    const runs = await runAll();
    for (const surface of SURFACES) {
      const run = runs[surface];
      expect(run.issued.length, surface).toBeGreaterThan(0);
      expect(Object.keys(run.stored).sort(), surface).toEqual(
        run.issued.map((claim) => claim.id).sort(),
      );
      // The route issued exactly buildClaimSet over the rows it persisted.
      const rebuilt = buildClaimSet({ rows: run.rows, surface: 'scout' }).claims;
      expect(
        rebuilt.map((claim) => [claim.id, claim.predicate, claim.value, claim.tier]),
        surface,
      ).toEqual(run.issued.map((claim) => [claim.id, claim.predicate, claim.value, claim.tier]));
    }
  });

  it('the legacy scout, prep_report and prep_bundle child issue claim sets DEEPLY EQUAL on (id, predicate, subject, value, claimKind, tier, policyVersion)', async () => {
    const runs = await runAll();
    const legacy = sharedFields(runs['legacy scout']);
    expect(legacy.length).toBeGreaterThanOrEqual(3);
    expect(sharedFields(runs.prep_report)).toEqual(legacy);
    expect(sharedFields(runs['prep_bundle child'])).toEqual(legacy);
  });

  it('predicate sets, compared rather than exempted: the ONLY predicate-level difference the synthesis surface brings is the vod_annotation family', async () => {
    const runs = await runAll();
    const scout = predicatesOf(runs['legacy scout']);
    expect(predicatesOf(runs.prep_report)).toEqual(scout);
    expect(predicatesOf(runs['prep_bundle child'])).toEqual(scout);
    expect(scout.has('vod_annotation')).toBe(false);

    const synthesis = predicatesOf(runs.post_event_synthesis);
    const addedBySynthesis = [...synthesis].filter((predicate) => !scout.has(predicate));
    expect(addedBySynthesis).toEqual(['vod_annotation']);
    expect(synthesis).toEqual(new Set(['vod_annotation']));
    // Every predicate is closed-enum, so nothing outside CLAIM_PREDICATES can hide here.
    for (const predicate of [...scout, ...synthesis]) {
      expect(CLAIM_PREDICATES).toContain(predicate);
    }
  });

  it('identical confidence treatment across all FOUR surfaces: the tier is one function of countable games, whichever surface issued the claim', async () => {
    const runs = await runAll();
    const tierByGames = new Map<number, ClaimAtom['tier']>();
    for (const surface of SURFACES) {
      for (const claim of runs[surface].issued) {
        const expected =
          claim.value.kind === 'abstained' ? null : confidenceTierFor(claim.sample.countableGames);
        expect(claim.tier, `${surface} ${claim.id}`).toBe(expected);
        if (claim.value.kind === 'abstained') {
          continue;
        }
        const seen = tierByGames.get(claim.sample.countableGames);
        if (seen !== undefined) {
          expect(claim.tier, `${surface} ${claim.id}`).toBe(seen);
        }
        tierByGames.set(claim.sample.countableGames, claim.tier);
      }
    }
    // The fixture spans more than one countable-games value, so the map is not vacuous.
    expect(tierByGames.size).toBeGreaterThan(1);
  });

  it('a claim’s content cannot depend on its surface: merging every surface’s stored rows into ONE claim set reproduces each claim’s predicate, subject, value, kind, tier and policy version', async () => {
    const runs = await runAll();
    const merged = buildClaimSet({
      rows: {
        ...runs['legacy scout'].rows,
        ...runs.prep_report.rows,
        ...runs['prep_bundle child'].rows,
        ...runs.post_event_synthesis.rows,
      },
      surface: 'scout',
    });
    expect(merged.truncatedCandidateCount).toBe(0);
    const contentOf = (claim: {
      predicate: ClaimPredicate;
      subject: ClaimAtom['subject'];
      value: ClaimAtom['value'];
      claimKind: ClaimAtom['claimKind'];
      tier: ClaimAtom['tier'];
      policyVersion: number;
    }) => ({
      predicate: claim.predicate,
      subject: claim.subject,
      value: claim.value,
      claimKind: claim.claimKind,
      tier: claim.tier,
      policyVersion: claim.policyVersion,
    });
    let compared = 0;
    for (const surface of SURFACES) {
      const run = runs[surface];
      const own = buildClaimSet({ rows: run.rows, surface: 'scout' }).claims;
      for (const claim of own) {
        const inMerged = merged.claims.find((candidate) =>
          candidate.evidenceIds.some((id) => claim.evidenceIds.includes(id)),
        );
        expect(inMerged, `${surface} ${claim.id}`).toBeDefined();
        expect(contentOf(inMerged!), `${surface} ${claim.id}`).toEqual(contentOf(claim));
        compared += 1;
      }
    }
    expect(compared).toBeGreaterThan(0);
  });

  it('the same fixture run twice issues the same claim sets on every surface', async () => {
    const first = await runAll();
    const second = await runAll();
    for (const surface of SURFACES) {
      expect(sharedFields(second[surface]), surface).toEqual(sharedFields(first[surface]));
    }
  });
});
