import { describe, expect, it } from 'vitest';
import {
  CITATION_LABEL_MAX_LENGTH,
  serializeCitationToken,
  type GeneratedPracticePlan,
} from '@smash-tracker/shared';
import { FakeDatabase } from '../test-support/fakeDatabase.js';
import {
  assembleSynthesisPayload,
  SynthesisValidationError,
  validatePracticePlanCitations,
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
