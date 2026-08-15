import { describe, expect, it } from 'vitest';
import {
  buildTournamentRegistryEntryId,
  buildTournamentRegistryWitness,
  tournamentRegistryRowSchema,
  type TournamentRegistryRow,
} from '@smash-tracker/shared';
import {
  getHistoricalFields,
  historicalTournamentEntryListSchema,
  historicalTournamentEntrySchema,
  isAdminImportedEntry,
} from './historicalTournament';

/**
 * Cross-package contract pin (Phase 30.3 integration): the web-local
 * historical mirror MUST accept every row the server-side registry contract
 * can emit. Two parallel agents built the two sides against the same written
 * contract and still diverged on one member type (`startggEventId`:
 * string on the wire, number in the first web mirror) — which would have
 * failed the WHOLE tournaments list parse for any account carrying a real
 * imported row. This test builds a row through the SHARED schema (the exact
 * shape `GET /api/tournaments` serializes, `entryKey` stamped the way the
 * route stamps it) and proves the web parse keeps every historical member.
 */

function buildSharedRegistryRow(): TournamentRegistryRow {
  const startggEventId = '1075744';
  return tournamentRegistryRowSchema.parse({
    entryId: buildTournamentRegistryEntryId(startggEventId),
    origin: 'admin-imported',
    provider: 'startgg',
    startggEventId,
    tournamentName: 'Supernova 2026',
    eventName: 'Ultimate Singles',
    tournamentSlug: 'tournament/supernova-2026',
    eventSlug: 'tournament/supernova-2026/event/ultimate-singles',
    startAtMs: 1_752_300_000_000,
    endAtMs: 1_752_386_400_000,
    numEntrants: 512,
    seed: 2,
    placement: 1,
    playedSetCount: 8,
    provenance: { source: 'research-import', importedAtMs: 1_786_800_000_000 },
    registryWitness: buildTournamentRegistryWitness(startggEventId),
    firstSetAt: 1_752_300_000_000,
    lastSetAt: 1_752_386_400_000,
    setsPlayed: 8,
    slug: 'tournament/supernova-2026',
  });
}

describe('historical tournament contract (shared registry row ↔ web mirror)', () => {
  it('a shared-schema registry row parses under the web mirror with every historical member intact', () => {
    const sharedRow = buildSharedRegistryRow();
    // GET /api/tournaments stamps the RTDB child key as entryKey on read.
    const wireRow = { ...sharedRow, entryKey: sharedRow.entryId };

    const parsed = historicalTournamentEntrySchema.parse(wireRow);
    expect(parsed.origin).toBe('admin-imported');
    expect(parsed.provider).toBe('startgg');
    expect(parsed.startggEventId).toBe('1075744');
    expect(parsed.tournamentSlug).toBe('tournament/supernova-2026');
    expect(parsed.startAtMs).toBe(1_752_300_000_000);
    expect(parsed.endAtMs).toBe(1_752_386_400_000);
    expect(parsed.playedSetCount).toBe(8);
    expect(parsed.provenance?.source).toBe('research-import');
    expect(parsed.provenance?.importedAtMs).toBe(1_786_800_000_000);
  });

  it('a mixed list (registry row + legacy rows) parses as a whole — one imported row can never sink the list', () => {
    const sharedRow = buildSharedRegistryRow();
    const legacyRow = {
      entryKey: '123456',
      eventName: 'Weekly 42',
      firstSetAt: 1_700_000_000_000,
      lastSetAt: 1_700_003_600_000,
      setsPlayed: 3,
      source: 'startgg',
    };
    const parsed = historicalTournamentEntryListSchema.parse([
      { ...sharedRow, entryKey: sharedRow.entryId },
      legacyRow,
    ]);
    expect(parsed).toHaveLength(2);
    expect(isAdminImportedEntry(parsed[0]!)).toBe(true);
    expect(isAdminImportedEntry(parsed[1]!)).toBe(false);
  });

  it('narrows via getHistoricalFields exactly for admin-imported rows', () => {
    const sharedRow = buildSharedRegistryRow();
    const parsed = historicalTournamentEntrySchema.parse({
      ...sharedRow,
      entryKey: sharedRow.entryId,
    });
    const fields = getHistoricalFields(parsed);
    expect(fields).not.toBeNull();
    expect(fields?.dqCount ?? null).toBeNull();
  });
});
