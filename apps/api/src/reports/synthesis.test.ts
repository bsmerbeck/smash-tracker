import { describe, expect, it } from 'vitest';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import {
  buildClaimSet,
  CITATION_LABEL_MAX_LENGTH,
  confidenceTierFor,
  EVIDENCE_POLICY_VERSION,
  parseVodEvidenceId,
  serializeCitationToken,
  storedPracticePlanSchema,
  vodEvidenceId,
  type ClaimAtom,
  type GeneratedPracticePlan,
} from '@smash-tracker/shared';
import { FakeDatabase } from '../test-support/fakeDatabase.js';
import {
  claimSelectionSchema,
  engineAuthoredSummary,
  type ClaimSelection,
} from './claimSelection.js';
import { ReportGenerationError, toModelFacingClaim } from './generate.js';
import {
  assembleSynthesisPayload,
  generatePracticePlan,
  projectPracticePlanSelection,
  SynthesisValidationError,
  validatePracticePlanCitations,
  type SynthesisAnthropicClient,
  type SynthesisPayload,
} from './synthesis.js';

const UID = 'test-uid-123';
const ENTRY_KEY = 'locals-42-abc123';
const FIRST_SET_AT = 1_700_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

function seedEntry(database: FakeDatabase, overrides: Record<string, unknown> = {}): void {
  database.seed(`tournamentEntries/${UID}/${ENTRY_KEY}`, {
    eventName: 'Locals #42',
    firstSetAt: FIRST_SET_AT,
    lastSetAt: FIRST_SET_AT,
    setsPlayed: 2,
    source: 'manual',
    ...overrides,
  });
}

function seedBrief(database: FakeDatabase, overrides: Record<string, unknown> = {}): void {
  database.seed(`prepBriefs/${UID}/${ENTRY_KEY}`, {
    eventDate: FIRST_SET_AT,
    activatedAt: FIRST_SET_AT,
    lastOpenedAt: FIRST_SET_AT,
    ...overrides,
  });
}

function seedMatch(
  database: FakeDatabase,
  id: string,
  overrides: Record<string, unknown> = {},
): void {
  database.seed(`matches/${UID}/${id}`, {
    fighter_id: 1,
    opponent_id: 2,
    time: FIRST_SET_AT,
    win: true,
    eventName: 'Locals #42',
    ...overrides,
  });
}

async function assemble(database: FakeDatabase) {
  return assembleSynthesisPayload(
    database as unknown as Parameters<typeof assembleSynthesisPayload>[0],
    UID,
    ENTRY_KEY,
  );
}

describe('assembleSynthesisPayload', () => {
  it('payload contains only event-scoped evidence: matches outside the entry window / uncurated cross-event opponents contribute nothing; synced and labeled-manual event matches both contribute their timestamps', async () => {
    const database = new FakeDatabase();
    seedEntry(database);
    seedBrief(database);

    // Synced, event-associated: contributes.
    seedMatch(database, 'synced-1', {
      source: 'startgg',
      time: FIRST_SET_AT,
      vodTimestamps: [{ seconds: 10, note: 'clean punish' }],
    });
    // Manual, event-associated (same eventName/window), uncurated opponent —
    // still contributes: event-association alone qualifies a manual row.
    seedMatch(database, 'manual-1', {
      opponent: 'randomfoe',
      time: FIRST_SET_AT,
      vodTimestamps: [{ seconds: 20, note: 'missed tech' }],
    });
    // Different event, uncurated opponent, within the padded time window —
    // excluded (neither event-associated nor curated).
    seedMatch(database, 'other-event', {
      eventName: 'Some Other Bracket',
      opponent: 'stranger',
      time: FIRST_SET_AT,
      vodTimestamps: [{ seconds: 99, note: 'should never appear' }],
    });
    // Same event, but time far outside the padded window — excluded.
    seedMatch(database, 'outside-window', {
      time: FIRST_SET_AT - 10 * DAY_MS,
      vodTimestamps: [{ seconds: 55, note: 'should never appear either' }],
    });

    const result = await assemble(database);

    expect(result.found).toBe(true);
    if (!result.found) return;
    const matchIds = result.payload.evidence.map((item) => item.matchId).sort();
    expect(matchIds).toEqual(['manual-1', 'synced-1']);
    expect(result.payload.evidence.every((item) => item.note !== 'should never appear')).toBe(true);
  });

  it('every evidence item carries a cite field equal to serializeCitationToken({sourceVodRef: matchId, seconds, label}) — byte-exact tokens', async () => {
    const database = new FakeDatabase();
    seedEntry(database);
    seedBrief(database);
    // `vodTimestampSchema.note` is capped at 200 chars — EXACTLY
    // `CITATION_LABEL_MAX_LENGTH` — so a note can never legitimately exceed
    // the label cap; the max-length note below proves the label truncation
    // is a no-op at the boundary rather than lossy.
    const maxLengthNote = 'x'.repeat(CITATION_LABEL_MAX_LENGTH);
    seedMatch(database, 'm1', {
      source: 'startgg',
      time: FIRST_SET_AT,
      vodTimestamps: [
        { seconds: 5, note: 'short note' },
        { seconds: 15, note: maxLengthNote },
      ],
    });

    const result = await assemble(database);
    expect(result.found).toBe(true);
    if (!result.found) return;

    const shortItem = result.payload.evidence.find((item) => item.seconds === 5)!;
    expect(shortItem.cite).toBe(
      serializeCitationToken({ sourceVodRef: 'm1', seconds: 5, label: 'short note' }),
    );

    const longItem = result.payload.evidence.find((item) => item.seconds === 15)!;
    expect(longItem.cite).toBe(
      serializeCitationToken({ sourceVodRef: 'm1', seconds: 15, label: maxLengthNote }),
    );
  });

  it('falls back to "vs {opponent}" for an empty note label', async () => {
    const database = new FakeDatabase();
    seedEntry(database);
    seedBrief(database);
    seedMatch(database, 'm1', {
      source: 'startgg',
      opponent: 'shadowfoe',
      time: FIRST_SET_AT,
      vodTimestamps: [{ seconds: 8, note: '' }],
    });

    const result = await assemble(database);
    expect(result.found).toBe(true);
    if (!result.found) return;

    const item = result.payload.evidence[0]!;
    expect(item.cite).toBe(
      serializeCitationToken({ sourceVodRef: 'm1', seconds: 8, label: 'vs shadowfoe' }),
    );
  });

  it('truncates the label to CITATION_LABEL_MAX_LENGTH when the "vs {opponent}" fallback itself would overflow it (an unbounded opponent name)', async () => {
    const database = new FakeDatabase();
    seedEntry(database);
    seedBrief(database);
    const longOpponentName = 'z'.repeat(CITATION_LABEL_MAX_LENGTH);
    seedMatch(database, 'm1', {
      source: 'startgg',
      opponent: longOpponentName,
      time: FIRST_SET_AT,
      vodTimestamps: [{ seconds: 8, note: '' }],
    });

    const result = await assemble(database);
    expect(result.found).toBe(true);
    if (!result.found) return;

    const item = result.payload.evidence[0]!;
    const expectedLabel = `vs ${longOpponentName}`.slice(0, CITATION_LABEL_MAX_LENGTH);
    expect(expectedLabel.length).toBe(CITATION_LABEL_MAX_LENGTH);
    expect(item.cite).toBe(
      serializeCitationToken({ sourceVodRef: 'm1', seconds: 8, label: expectedLabel }),
    );
  });

  it('allowedPairs is exactly the set of (matchId, seconds) pairs of the assembled evidence, and allowedTokens is exactly the serialized token set', async () => {
    const database = new FakeDatabase();
    seedEntry(database);
    seedBrief(database);
    seedMatch(database, 'm1', {
      source: 'startgg',
      time: FIRST_SET_AT,
      vodTimestamps: [
        { seconds: 5, note: 'one' },
        { seconds: 15, note: 'two' },
      ],
    });
    seedMatch(database, 'm2', {
      source: 'startgg',
      time: FIRST_SET_AT,
      vodTimestamps: [{ seconds: 25, note: 'three' }],
    });

    const result = await assemble(database);
    expect(result.found).toBe(true);
    if (!result.found) return;

    expect(result.allowedPairs).toEqual(new Set(['m1:5', 'm1:15', 'm2:25']));
    expect(result.allowedTokens).toEqual(new Set(result.payload.evidence.map((item) => item.cite)));
    expect(result.allowedPairs.size).toBe(result.payload.evidence.length);
  });

  it('tags ride the evidence item text, never a separate citable id — one cite token per timestamp entry regardless of tag count', async () => {
    const database = new FakeDatabase();
    seedEntry(database);
    seedBrief(database);
    seedMatch(database, 'm1', {
      source: 'startgg',
      time: FIRST_SET_AT,
      vodTimestamps: [{ seconds: 5, note: 'punish window', tags: ['punish', 'recovery'] }],
    });

    const result = await assemble(database);
    expect(result.found).toBe(true);
    if (!result.found) return;

    expect(result.payload.evidence).toHaveLength(1);
    expect(result.payload.evidence[0]!.tags).toEqual(['punish', 'recovery']);
  });

  it('legacy dense-array timestamp records contribute pair-identified evidence — the legacy-index entry id appears NOWHERE in the payload or tokens', async () => {
    const database = new FakeDatabase();
    seedEntry(database);
    seedBrief(database);
    // Legacy dense array shape: a plain array with no `id` field on entries.
    seedMatch(database, 'm1', {
      source: 'startgg',
      time: FIRST_SET_AT,
      vodTimestamps: [{ seconds: 30, note: 'legacy note' }],
    });

    const result = await assemble(database);
    expect(result.found).toBe(true);
    if (!result.found) return;

    expect(result.payload.evidence).toHaveLength(1);
    const item = result.payload.evidence[0]!;
    expect(item.matchId).toBe('m1');
    expect(item.seconds).toBe(30);
    const serialized = JSON.stringify(result.payload);
    expect(serialized).not.toContain('legacy-');
    expect(item.cite).not.toContain('legacy-');
  });

  it('evidenceCount is 0 for an event with no annotations', async () => {
    const database = new FakeDatabase();
    seedEntry(database);
    seedBrief(database);
    seedMatch(database, 'm1', { source: 'startgg', time: FIRST_SET_AT });

    const result = await assemble(database);
    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.evidenceCount).toBe(0);
    expect(result.payload.evidence).toEqual([]);
  });

  it('a missing brief yields a not-found signal, never partial assembly', async () => {
    const database = new FakeDatabase();
    seedEntry(database);
    // No brief seeded.

    const result = await assemble(database);
    expect(result).toEqual({ found: false });
  });

  it('a foreign entryKey (registry row absent) yields a not-found signal, never partial assembly', async () => {
    const database = new FakeDatabase();
    seedBrief(database);
    // No tournamentEntries row seeded for this entryKey.

    const result = await assemble(database);
    expect(result).toEqual({ found: false });
  });
});

describe('validatePracticePlanCitations', () => {
  function plan(focusAreas: GeneratedPracticePlan['focusAreas']): GeneratedPracticePlan {
    return { summary: 'Overall plan summary', focusAreas };
  }

  function token(matchId: string, seconds: number, label = 'note'): string {
    return serializeCitationToken({ sourceVodRef: matchId, seconds, label });
  }

  it('INV-1: citation tokens resolve to exact stored evidence IDs, not display text — a byte-identical label with a non-allowed pair is dropped; a mangled label with an allowed pair survives', () => {
    const allowedPairs = new Set(['match-1:30']);
    const droppedByLabelTrick = {
      title: 'Fake grounding',
      evidence: `Looks right: ${token('match-2', 30, 'exact label text')}`,
      drills: ['drill'],
    };
    const survivesDespiteMangledLabel = {
      title: 'Real grounding',
      evidence: `${token('match-1', 30, 'trun...')}`,
      drills: ['drill'],
    };

    const result = validatePracticePlanCitations(
      plan([droppedByLabelTrick, survivesDespiteMangledLabel]),
      allowedPairs,
    );

    expect(result.plan.focusAreas).toEqual([survivesDespiteMangledLabel]);
    expect(result.droppedClaimCount).toBe(1);
  });

  it("INV-1: resolution is set-membership against the server-assembled universe — a pair absent from THIS payload's allowedPairs is dropped even though it names a real match", () => {
    const allowedPairs = new Set(['match-1:30']);
    const fromAnotherPayload = {
      title: 'Different assembly',
      evidence: token('match-9', 999),
      drills: ['drill'],
    };
    const inThisPayload = {
      title: 'This assembly',
      evidence: token('match-1', 30),
      drills: ['drill'],
    };

    const result = validatePracticePlanCitations(
      plan([fromAnotherPayload, inThisPayload]),
      allowedPairs,
    );

    expect(result.plan.focusAreas).toEqual([inThisPayload]);
    expect(result.droppedClaimCount).toBe(1);
  });

  it('a focusArea with zero citation tokens is dropped', () => {
    const allowedPairs = new Set(['match-1:30']);
    const uncited = { title: 'No grounding', evidence: 'Just prose, no tokens.', drills: ['d'] };
    const cited = { title: 'Grounded', evidence: token('match-1', 30), drills: ['d'] };

    const result = validatePracticePlanCitations(plan([uncited, cited]), allowedPairs);

    expect(result.plan.focusAreas).toEqual([cited]);
    expect(result.droppedClaimCount).toBe(1);
  });

  it('a focusArea with one valid and one invalid token is dropped (all-tokens-must-resolve)', () => {
    const allowedPairs = new Set(['match-1:30']);
    const mixed = {
      title: 'Half grounded',
      evidence: `${token('match-1', 30)} and also ${token('match-2', 999)}`,
      drills: ['d'],
    };
    const cited = { title: 'Fully grounded', evidence: token('match-1', 30), drills: ['d'] };

    const result = validatePracticePlanCitations(plan([mixed, cited]), allowedPairs);

    expect(result.plan.focusAreas).toEqual([cited]);
    expect(result.droppedClaimCount).toBe(1);
  });

  it('malformed tokens are treated as invalid, never a crash', () => {
    const allowedPairs = new Set(['match-1:30']);
    const malformed = {
      title: 'Broken token',
      evidence: '{{cite:matchId=match-1;seconds=not-a-number;label=x}}',
      drills: ['d'],
    };
    const cited = { title: 'Grounded', evidence: token('match-1', 30), drills: ['d'] };

    expect(() =>
      validatePracticePlanCitations(plan([malformed, cited]), allowedPairs),
    ).not.toThrow();
    const result = validatePracticePlanCitations(plan([malformed, cited]), allowedPairs);
    expect(result.plan.focusAreas).toEqual([cited]);
    expect(result.droppedClaimCount).toBe(1);
  });

  it("INV-2: zero surviving claims throws SynthesisValidationError with reason 'uncitable'", () => {
    const allowedPairs = new Set(['match-1:30']);
    const allDropped = [
      { title: 'No grounding', evidence: 'no tokens here', drills: ['d'] },
      { title: 'Bad pair', evidence: token('match-9', 999), drills: ['d'] },
    ];

    expect(() => validatePracticePlanCitations(plan(allDropped), allowedPairs)).toThrow(
      SynthesisValidationError,
    );
    try {
      validatePracticePlanCitations(plan(allDropped), allowedPairs);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(SynthesisValidationError);
      expect((error as SynthesisValidationError).reason).toBe('uncitable');
    }
  });

  it('droppedClaimCount reports the number of dropped focusAreas and survivors keep their original order', () => {
    const allowedPairs = new Set(['match-1:30']);
    const first = { title: 'First', evidence: token('match-1', 30), drills: ['d'] };
    const second = { title: 'Second', evidence: 'no tokens', drills: ['d'] };
    const third = { title: 'Third', evidence: token('match-1', 30), drills: ['d'] };

    const result = validatePracticePlanCitations(plan([first, second, third]), allowedPairs);

    expect(result.plan.focusAreas).toEqual([first, third]);
    expect(result.droppedClaimCount).toBe(1);
  });
});

describe('generatePracticePlan', () => {
  const PAYLOAD: SynthesisPayload = {
    entry: {
      eventName: 'Locals #42',
      tournamentName: null,
      dates: {
        firstSetAt: new Date(FIRST_SET_AT).toISOString(),
        lastSetAt: new Date(FIRST_SET_AT).toISOString(),
      },
    },
    briefContext: {
      reviewChecklistProgress: { completed: 2, total: 5 },
      likelyOpponents: ['opp1'],
    },
    results: { wins: 1, losses: 1 },
    evidence: [
      {
        matchId: 'm1',
        opponent: 'opp1',
        result: 'win',
        time: new Date(FIRST_SET_AT).toISOString(),
        seconds: 30,
        note: 'clean punish',
        tags: ['punish'],
        cite: serializeCitationToken({ sourceVodRef: 'm1', seconds: 30, label: 'clean punish' }),
        claimId: 'c01',
      },
      {
        matchId: 'm2',
        opponent: 'opp1',
        result: 'loss',
        time: new Date(FIRST_SET_AT).toISOString(),
        seconds: 90,
        note: 'missed tech',
        tags: [],
        cite: serializeCitationToken({ sourceVodRef: 'm2', seconds: 90, label: 'missed tech' }),
        claimId: 'c02',
      },
    ],
    claims: [],
    actionCandidates: [],
  };

  // Plan 39-08: the model's output is a claim SELECTION (the scout path's
  // schema), no longer a free-prose `GeneratedPracticePlan`.
  const VALID_PLAN: ClaimSelection = {
    sections: {
      overview: { claimIds: ['c01', 'c02'], connective: 'Focus on punish consistency.' },
      gameplan: { claimIds: ['c01'], connective: 'Convert your punishes.' },
      watchFor: { claimIds: ['c02'], connective: 'Watch for missed techs.' },
    },
    action1: null,
    action2: null,
    action3: null,
  };

  it('a fake client returning a valid parsed plan yields the plan', async () => {
    const client: SynthesisAnthropicClient = {
      messages: {
        parse: async () => ({ stop_reason: 'end_turn', parsed_output: VALID_PLAN }),
      },
    };

    const result = await generatePracticePlan(client, PAYLOAD);
    expect(result).toEqual(VALID_PLAN);
  });

  it('refusal / truncated / unparseable map to the same error class family generate.ts uses', async () => {
    const refusalClient: SynthesisAnthropicClient = {
      messages: { parse: async () => ({ stop_reason: 'refusal', parsed_output: null }) },
    };
    await expect(generatePracticePlan(refusalClient, PAYLOAD)).rejects.toBeInstanceOf(
      ReportGenerationError,
    );

    const truncatedClient: SynthesisAnthropicClient = {
      messages: { parse: async () => ({ stop_reason: 'max_tokens', parsed_output: null }) },
    };
    await expect(generatePracticePlan(truncatedClient, PAYLOAD)).rejects.toMatchObject({
      reason: 'truncated',
    });

    const unparseableClient: SynthesisAnthropicClient = {
      messages: { parse: async () => ({ stop_reason: 'end_turn', parsed_output: null }) },
    };
    await expect(generatePracticePlan(unparseableClient, PAYLOAD)).rejects.toMatchObject({
      reason: 'unparseable',
    });
  });

  it('the user message carries every evidence item (with its claim id) and the prompt states the select-and-connect contract', async () => {
    // Plan 39-08 migration: the pre-39-08 prompt told the model to copy each
    // item's cite token VERBATIM into focusArea evidence. The model now
    // SELECTS claim ids; the prompt's contract is select-and-connect.
    let capturedSystem = '';
    let capturedContent = '';
    const client: SynthesisAnthropicClient = {
      messages: {
        parse: async (params) => {
          capturedSystem = params.system;
          capturedContent = params.messages[0]!.content;
          return { stop_reason: 'end_turn', parsed_output: VALID_PLAN };
        },
      },
    };

    await generatePracticePlan(client, PAYLOAD);

    const sent = JSON.parse(capturedContent) as SynthesisPayload;
    expect(sent.evidence.map((item) => item.claimId)).toEqual(['c01', 'c02']);
    expect(capturedSystem).toContain('choose which moments matter most');
    expect(capturedSystem).toContain('Do not compute, count, rank or estimate anything');
    expect(capturedSystem).toContain('Use only claim ids and action ids that appear in the input');
    expect(capturedSystem).toContain('"abstained" is a gap in the evidence');
    expect(capturedSystem).not.toMatch(/\d/);
    expect(capturedSystem).not.toMatch(/confidence|hedg|VERBATIM/i);
  });
});

// ---------------------------------------------------------------------------
// Phase 39 (plan 39-08 Task 1): the synthesis surface on the shared claim
// pipeline — vod_annotation rows, snapshot, claim set, schema, projection.
// ---------------------------------------------------------------------------

/** Seeds a fixed three-game event: m1 (two moments, a Battlefield loss vs "rival"), m2 (one moment, unknown stage), m3 (one moment). */
function seedThreeAnnotatedGames(database: FakeDatabase): void {
  seedEntry(database);
  seedBrief(database);
  seedMatch(database, 'm1', {
    source: 'startgg',
    opponent: 'rival',
    win: false,
    map: { id: 1, name: 'Battlefield' },
    vodTimestamps: [
      { seconds: 5, note: 'one' },
      { seconds: 15, note: 'two' },
    ],
  });
  seedMatch(database, 'm2', {
    source: 'startgg',
    map: { id: 0, name: 'No selection' },
    vodTimestamps: [{ seconds: 25, note: 'three' }],
  });
  seedMatch(database, 'm3', {
    source: 'startgg',
    opponent_id: 8,
    vodTimestamps: [{ seconds: 35, note: 'four' }],
  });
  // An un-annotated event game: part of the event's sample, not a row.
  seedMatch(database, 'm4', { source: 'startgg' });
}

describe('assembleSynthesisPayload: vod_annotation rows, snapshot and claim set (plan 39-08, D-02/RPT-05)', () => {
  it('C1-M8: emitted evidence ids are exactly vodEvidenceId(pair) for every allowedPairs member, and parse back to the original pairs — through the bijection, never a raw string compare', async () => {
    const database = new FakeDatabase();
    seedThreeAnnotatedGames(database);

    const result = await assemble(database);
    expect(result.found).toBe(true);
    if (!result.found) return;

    const vodClaims = result.claimSet.claims.filter(
      (claim) => claim.predicate === 'vod_annotation',
    );
    expect(vodClaims).toHaveLength(result.claimSet.claims.length);
    const emittedIds = new Set(vodClaims.flatMap((claim) => claim.evidenceIds));

    // allowedPairs -> ids, through the encoder.
    const idsFromPairs = new Set(
      [...result.allowedPairs].map((pair) => {
        const separator = pair.lastIndexOf(':');
        return vodEvidenceId(pair.slice(0, separator), Number(pair.slice(separator + 1)));
      }),
    );
    expect(emittedIds).toEqual(idsFromPairs);
    expect(new Set(Object.keys(result.rows))).toEqual(idsFromPairs);

    // ids -> pairs, through the decoder: the round trip reproduces the pair set.
    const pairsFromIds = new Set(
      [...emittedIds].map((id) => {
        const parsed = parseVodEvidenceId(id);
        expect(parsed).not.toBeNull();
        return `${parsed!.matchId}:${parsed!.seconds}`;
      }),
    );
    expect(pairsFromIds).toEqual(result.allowedPairs);
  });

  it('every evidence item names the claim its moment was issued as, and the model-facing claims are the shared projection of the issued set', async () => {
    const database = new FakeDatabase();
    seedThreeAnnotatedGames(database);

    const result = await assemble(database);
    if (!result.found) throw new Error('expected found');

    for (const item of result.payload.evidence) {
      const claim = result.claimSet.claims.find((candidate) =>
        candidate.evidenceIds.includes(vodEvidenceId(item.matchId, item.seconds)),
      );
      expect(claim).toBeDefined();
      expect(item.claimId).toBe(claim!.id);
    }
    expect(result.payload.claims).toEqual(result.claimSet.claims.map(toModelFacingClaim));
  });

  it('the claim set is buildClaimSet over the emitted rows (the SAME builder), and the snapshot carries exactly those rows', async () => {
    const database = new FakeDatabase();
    seedThreeAnnotatedGames(database);

    const result = await assemble(database);
    if (!result.found) throw new Error('expected found');

    expect(buildClaimSet({ rows: result.rows, surface: 'post_event_synthesis' })).toEqual(
      result.claimSet,
    );
    expect(result.snapshot.rows).toBe(result.rows);
    expect(result.snapshot.policyVersion).toBe(EVIDENCE_POLICY_VERSION);
    expect(result.snapshot.matchIdDigest.count).toBe(4);
    expect(result.snapshot.matchIdDigest.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('subject axes are the moment’s KNOWN match context; the sample is the event’s annotated games out of all its games', async () => {
    const database = new FakeDatabase();
    seedThreeAnnotatedGames(database);

    const result = await assemble(database);
    if (!result.found) throw new Error('expected found');

    expect(result.rows[vodEvidenceId('m1', 5)]!.subject).toEqual({
      myFighterId: 1,
      opponentFighterId: 2,
      stageId: 1,
      opponentTag: 'rival',
    });
    // The no-selection stage (id 0) is never a claimable entity.
    expect(result.rows[vodEvidenceId('m2', 25)]!.subject.stageId).toBeNull();
    expect(result.rows[vodEvidenceId('m2', 25)]!.subject.opponentTag).toBeNull();
    for (const row of Object.values(result.rows)) {
      expect(row.predicate).toBe('vod_annotation');
      expect(row.sample.rawSampleSize).toBe(4);
      expect(row.sample.eligibleDenominator).toBe(3);
      expect(row.sample.confidenceTier).toBe(confidenceTierFor(3));
    }
    // Three annotated games clear the floor: one evidenced claim per moment,
    // valued at its recorded offset.
    expect(result.claimSet.claims).toHaveLength(4);
    expect(
      result.claimSet.claims
        .map((claim) => (claim.value.kind === 'count' ? claim.value.count : -1))
        .sort((a, b) => a - b),
    ).toEqual([5, 15, 25, 35]);
    expect(result.claimSet.claims.every((claim) => claim.tier === confidenceTierFor(3))).toBe(true);
  });

  it("a lost annotated event match is a reviewable VOD ref: moments against the lost game's opponent character license vod_review, others do not", async () => {
    const database = new FakeDatabase();
    seedThreeAnnotatedGames(database);

    const result = await assemble(database);
    if (!result.found) throw new Error('expected found');

    // m1 is the one LOST annotated game (vs fighter 2). The shipped
    // `matchesVodRef` matches a claim to a lost VOD by opponent character, so
    // every moment against fighter 2 (m1, m2) licenses it; m3 (vs fighter 8)
    // does not.
    const matchIdOf = (claim: ClaimAtom) => parseVodEvidenceId(claim.evidenceIds[0]!)!.matchId;
    const vsFighter2 = result.claimSet.claims
      .filter((claim) => matchIdOf(claim) !== 'm3')
      .map((claim) => claim.id);
    const vsFighter8 = result.claimSet.claims
      .filter((claim) => matchIdOf(claim) === 'm3')
      .map((claim) => claim.id);
    const reviewed = result.actionCandidates
      .filter((candidate) => candidate.kind === 'vod_review')
      .flatMap((candidate) => candidate.claimIds);
    expect(new Set(reviewed)).toEqual(new Set(vsFighter2));
    expect(reviewed.some((id) => vsFighter8.includes(id))).toBe(false);
    expect(result.payload.actionCandidates.map((candidate) => candidate.id)).toEqual(
      result.actionCandidates.map((candidate) => candidate.id),
    );
  });
});

describe('generatePracticePlan: claim-selection schema and guard order (plan 39-08, C1-M4)', () => {
  const PAYLOAD: SynthesisPayload = {
    entry: {
      eventName: 'Locals #42',
      tournamentName: null,
      dates: { firstSetAt: 'a', lastSetAt: 'b' },
    },
    briefContext: { reviewChecklistProgress: { completed: 0, total: 5 }, likelyOpponents: [] },
    results: { wins: 0, losses: 0 },
    evidence: [],
    claims: [],
    actionCandidates: [],
  };
  const SELECTION: ClaimSelection = {
    sections: {
      overview: { claimIds: ['c01'], connective: 'x' },
      gameplan: { claimIds: [], connective: 'y' },
      watchFor: { claimIds: [], connective: 'z' },
    },
    action1: null,
    action2: null,
    action3: null,
  };

  it('sends the claim-selection schema with the unchanged model parameters', async () => {
    let captured: Parameters<SynthesisAnthropicClient['messages']['parse']>[0] | null = null;
    const client: SynthesisAnthropicClient = {
      messages: {
        parse: async (params) => {
          captured = params;
          return { stop_reason: 'end_turn', parsed_output: SELECTION };
        },
      },
    };

    await expect(generatePracticePlan(client, PAYLOAD)).resolves.toEqual(SELECTION);

    expect(captured).not.toBeNull();
    const params = captured!;
    expect(params.model).toBe('claude-opus-4-8');
    expect(params.max_tokens).toBe(16000);
    expect(params.thinking).toEqual({ type: 'adaptive' });
    expect(params.messages).toEqual([{ role: 'user', content: JSON.stringify(PAYLOAD) }]);
    expect(JSON.stringify(params.output_config.format.schema)).toBe(
      JSON.stringify(zodOutputFormat(claimSelectionSchema).schema),
    );
  });

  it('guard order is unchanged: refusal before truncation before a null parse, even with a parsed body present', async () => {
    const refusal: SynthesisAnthropicClient = {
      messages: { parse: async () => ({ stop_reason: 'refusal', parsed_output: SELECTION }) },
    };
    await expect(generatePracticePlan(refusal, PAYLOAD)).rejects.toMatchObject({
      reason: 'refusal',
    });
    const truncated: SynthesisAnthropicClient = {
      messages: { parse: async () => ({ stop_reason: 'max_tokens', parsed_output: SELECTION }) },
    };
    await expect(generatePracticePlan(truncated, PAYLOAD)).rejects.toMatchObject({
      reason: 'truncated',
    });
  });
});

describe('projectPracticePlanSelection (plan 39-08, reviews C1-B1 + C2-H2(a))', () => {
  function vodClaim(
    id: string,
    seconds: number,
    subject: Partial<ClaimAtom['subject']>,
  ): ClaimAtom {
    return {
      id: id as ClaimAtom['id'],
      predicate: 'vod_annotation',
      subject: {
        myFighterId: null,
        opponentFighterId: null,
        stageId: null,
        opponentTag: null,
        ...subject,
      },
      value: { kind: 'count', count: seconds },
      claimKind: 'fact',
      evidenceIds: [vodEvidenceId(`m-${id}`, seconds)],
      tier: 'low',
      policyVersion: EVIDENCE_POLICY_VERSION,
      sample: {
        rawSampleSize: 4,
        eligibleDenominator: 3,
        knownFieldCoverage: 0.75,
        dateRange: { firstMs: FIRST_SET_AT, lastMs: FIRST_SET_AT },
        refreshedAt: FIRST_SET_AT,
        evidencePolicyVersion: EVIDENCE_POLICY_VERSION,
        recencyTreatment: 'unweighted',
        confidenceTier: 'low',
      },
    };
  }
  const CLAIMS = [
    vodClaim('c01', 42, { myFighterId: 1, opponentFighterId: 2 }),
    vodClaim('c02', 10, { myFighterId: 1, opponentFighterId: 8, opponentTag: 'rival' }),
  ];
  function selection(overview: string): ClaimSelection {
    return {
      sections: {
        overview: { claimIds: ['c01', 'c02'], connective: overview },
        gameplan: { claimIds: ['c02'], connective: 'Drill it.' },
        watchFor: { claimIds: [], connective: 'Watch it.' },
      },
      action1: null,
      action2: null,
      action3: null,
    };
  }
  const VALIDATION = {
    status: 'passed' as const,
    policyVersion: EVIDENCE_POLICY_VERSION,
    snapshotId: 'a'.repeat(64),
    claimSchemaVersion: 1,
  };

  it('C1-B1: a well-formed selection projects onto a record the UNCHANGED stored schema accepts, with a non-empty summary and NO focusAreas own-property', () => {
    const projected = projectPracticePlanSelection({
      entryKey: ENTRY_KEY,
      createdAt: FIRST_SET_AT,
      selection: selection('Tighten your punishes.'),
      claims: CLAIMS,
      validation: VALIDATION,
    });
    const parsed = storedPracticePlanSchema.parse(projected);
    expect(parsed.summary).toBe('Tighten your punishes.');
    expect(Object.prototype.hasOwnProperty.call(projected, 'focusAreas')).toBe(false);
    expect(parsed.focusAreas).toEqual([]);
    expect(Object.keys(projected.claims ?? {})).toEqual(['c01', 'c02']);
    expect(projected.validation).toEqual(VALIDATION);
    for (const absent of ['droppedClaimCount', 'strippedSectionCount']) {
      expect(Object.prototype.hasOwnProperty.call(projected, absent)).toBe(false);
    }
  });

  it('C2-H2(a): an overview the validator STRIPPED projects to a record the schema accepts, with summary === engineAuthoredSummary(surviving claims) — never an empty string', () => {
    const projected = projectPracticePlanSelection({
      entryKey: ENTRY_KEY,
      createdAt: FIRST_SET_AT,
      selection: selection('Your record here is 18-2.'),
      claims: CLAIMS,
      strippedSectionIds: ['overview'],
      droppedClaimCount: 1,
    });
    expect(() => storedPracticePlanSchema.parse(projected)).not.toThrow();
    expect(projected.summary).toBe(engineAuthoredSummary(CLAIMS));
    expect(projected.summary.length).toBeGreaterThan(0);
    expect(projected.summary).not.toContain('18');
    expect(projected.sections?.overview?.connective).toBe('');
    expect(projected.strippedSectionCount).toBe(1);
    expect(projected.droppedClaimCount).toBe(1);
  });

  it('C2-H2(a): an overview connective that is empty after NFC normalisation and trimming falls back the same way', () => {
    const projected = projectPracticePlanSelection({
      entryKey: ENTRY_KEY,
      createdAt: FIRST_SET_AT,
      selection: selection('  \n\t '),
      claims: CLAIMS,
    });
    expect(storedPracticePlanSchema.parse(projected).summary).toBe(engineAuthoredSummary(CLAIMS));
  });

  it('C2-H2(a): with ALL THREE sections stripped the record still parses, carries the fallback summary and strippedSectionCount 3', () => {
    const projected = projectPracticePlanSelection({
      entryKey: ENTRY_KEY,
      createdAt: FIRST_SET_AT,
      selection: selection('Stripped.'),
      claims: CLAIMS,
      strippedSectionIds: ['overview', 'gameplan', 'watchFor'],
    });
    const parsed = storedPracticePlanSchema.parse(projected);
    expect(parsed.summary).toBe(engineAuthoredSummary(CLAIMS));
    expect(parsed.strippedSectionCount).toBe(3);
    for (const section of Object.values(parsed.sections ?? {})) {
      expect(section.connective).toBe('');
    }
  });
});
