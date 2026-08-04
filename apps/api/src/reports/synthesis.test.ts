import { describe, expect, it } from 'vitest';
import { CITATION_LABEL_MAX_LENGTH, serializeCitationToken } from '@smash-tracker/shared';
import { FakeDatabase } from '../test-support/fakeDatabase.js';
import { assembleSynthesisPayload } from './synthesis.js';

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
