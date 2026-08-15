import { describe, expect, it } from 'vitest';
import type { TournamentEntry } from '@smash-tracker/shared';
import {
  entryDisplayDateRange,
  entryDisplaySetsPlayed,
  getHistoricalFields,
  historicalTournamentEntryListSchema,
  importedProviderDisplayName,
  isAdminImportedEntry,
} from './historicalTournament';

function makeEntry(overrides: Record<string, unknown> = {}): TournamentEntry {
  return {
    eventName: 'Ultimate Singles',
    firstSetAt: 1_700_000_000_000,
    lastSetAt: 1_700_100_000_000,
    setsPlayed: 5,
    entryKey: '12345',
    ...overrides,
  } as TournamentEntry;
}

describe('historicalTournamentEntryListSchema', () => {
  it('parses legacy rows that carry none of the historical fields', () => {
    const result = historicalTournamentEntryListSchema.safeParse([makeEntry()]);
    expect(result.success).toBe(true);
  });

  it('parses admin-imported rows with the full historical contract', () => {
    const result = historicalTournamentEntryListSchema.safeParse([
      makeEntry({
        origin: 'admin-imported',
        provider: 'startgg',
        // A STRING on the wire — the shared registry contract's stable provider id.
        startggEventId: '987654',
        tournamentName: 'The Big House 9',
        tournamentSlug: 'tournament/the-big-house-9',
        eventSlug: 'tournament/the-big-house-9/event/ultimate-singles',
        startAtMs: 1_690_000_000_000,
        endAtMs: 1_690_100_000_000,
        numEntrants: 512,
        seed: 12,
        placement: 9,
        playedSetCount: 6,
        dqCount: 1,
        provenance: {
          source: 'research-import',
          importedAtMs: 1_723_000_000_000,
          asOfMs: 1_722_000_000_000,
        },
      }),
    ]);
    expect(result.success).toBe(true);
  });

  it('tolerates unknown origin values rather than failing the whole list', () => {
    const result = historicalTournamentEntryListSchema.safeParse([
      makeEntry({ origin: 'some-future-origin' }),
    ]);
    expect(result.success).toBe(true);
  });
});

describe('isAdminImportedEntry / getHistoricalFields', () => {
  it('detects admin-imported rows and only those', () => {
    expect(isAdminImportedEntry(makeEntry({ origin: 'admin-imported' }))).toBe(true);
    expect(isAdminImportedEntry(makeEntry())).toBe(false);
    expect(isAdminImportedEntry(makeEntry({ origin: 'some-future-origin' }))).toBe(false);
    expect(getHistoricalFields(makeEntry())).toBeNull();
  });
});

describe('importedProviderDisplayName', () => {
  it('maps startgg to the untranslated start.gg display name', () => {
    expect(
      importedProviderDisplayName(makeEntry({ origin: 'admin-imported', provider: 'startgg' })),
    ).toBe('start.gg');
  });

  it('defaults to start.gg when the provider field is absent', () => {
    expect(importedProviderDisplayName(makeEntry({ origin: 'admin-imported' }))).toBe('start.gg');
  });

  it('passes through unknown provider codes verbatim', () => {
    expect(
      importedProviderDisplayName(makeEntry({ origin: 'admin-imported', provider: 'other.gg' })),
    ).toBe('other.gg');
  });
});

describe('entryDisplayDateRange', () => {
  it('prefers the imported event dates when recorded', () => {
    const range = entryDisplayDateRange(
      makeEntry({ origin: 'admin-imported', startAtMs: 100, endAtMs: 200 }),
    );
    expect(range).toEqual({ startMs: 100, endMs: 200 });
  });

  it('uses startAtMs for both ends when endAtMs is missing', () => {
    const range = entryDisplayDateRange(makeEntry({ origin: 'admin-imported', startAtMs: 100 }));
    expect(range).toEqual({ startMs: 100, endMs: 100 });
  });

  it('falls back to the observed set window when no event dates were imported', () => {
    const range = entryDisplayDateRange(
      makeEntry({ origin: 'admin-imported', firstSetAt: 300, lastSetAt: 400 }),
    );
    expect(range).toEqual({ startMs: 300, endMs: 400 });
  });

  it('returns null — missing, never epoch zero — when nothing was recorded', () => {
    expect(
      entryDisplayDateRange(makeEntry({ origin: 'admin-imported', firstSetAt: 0, lastSetAt: 0 })),
    ).toBeNull();
  });
});

describe('entryDisplaySetsPlayed', () => {
  it('prefers the DQ-excluded playedSetCount on imported rows', () => {
    expect(entryDisplaySetsPlayed(makeEntry({ origin: 'admin-imported', playedSetCount: 7 }))).toBe(
      7,
    );
  });

  it('uses the registry setsPlayed everywhere else', () => {
    expect(entryDisplaySetsPlayed(makeEntry())).toBe(5);
    expect(entryDisplaySetsPlayed(makeEntry({ origin: 'admin-imported' }))).toBe(5);
  });
});
