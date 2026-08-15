import { describe, expect, it } from 'vitest';
import {
  buildTournamentRegistryEntryId,
  buildTournamentRegistryWitness,
  isTournamentRegistryOwnedRow,
  TOURNAMENT_REGISTRY_ENTRY_ID_PREFIX,
  TOURNAMENT_REGISTRY_WITNESS_PREFIX,
  tournamentRegistryListSchema,
  tournamentRegistryRowSchema,
  type TournamentRegistryRow,
} from './tournamentRegistry.js';
import { tournamentEntrySchema } from './startgg.js';

/** A fully-populated valid row — the canonical fixture the suite narrows from. */
function makeRow(overrides: Partial<TournamentRegistryRow> = {}): TournamentRegistryRow {
  return {
    entryId: 'histimport:100001',
    origin: 'admin-imported',
    provider: 'startgg',
    startggEventId: '100001',
    tournamentName: 'The Big House 9',
    eventName: 'Ultimate Singles',
    tournamentSlug: 'tournament/the-big-house-9',
    eventSlug: 'tournament/the-big-house-9/event/ultimate-singles',
    startAtMs: 1_700_000_000_000,
    endAtMs: 1_700_000_500_000,
    numEntrants: 512,
    seed: 3,
    placement: 2,
    playedSetCount: 8,
    dqCount: 1,
    provenance: {
      source: 'research-import',
      importedAtMs: 1_755_000_000_000,
      asOfMs: 1_754_000_000_000,
    },
    registryWitness: 'research-import:v1:100001',
    firstSetAt: 1_700_000_000_000,
    lastSetAt: 1_700_000_500_000,
    setsPlayed: 8,
    slug: 'tournament/the-big-house-9',
    ...overrides,
  };
}

describe('tournamentRegistryRowSchema', () => {
  it('round-trips a fully-populated row', () => {
    const row = makeRow();
    expect(tournamentRegistryRowSchema.parse(row)).toEqual(row);
  });

  it('accepts a minimal row with every optional member absent', () => {
    const minimal = {
      entryId: 'histimport:9',
      origin: 'admin-imported',
      provider: 'startgg',
      startggEventId: '9',
      eventName: 'start.gg event 9',
      playedSetCount: 0,
      provenance: { source: 'research-import', importedAtMs: 1 },
      registryWitness: 'research-import:v1:9',
      firstSetAt: 0,
      lastSetAt: 0,
      setsPlayed: 0,
    };
    expect(tournamentRegistryRowSchema.parse(minimal)).toEqual(minimal);
  });

  it('rejects a row without the origin discriminator', () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- rest-destructure-to-omit idiom; `origin` is intentionally discarded
    const { origin: _origin, ...rest } = makeRow();
    expect(tournamentRegistryRowSchema.safeParse(rest).success).toBe(false);
  });

  it('rejects any origin other than admin-imported and any provider other than startgg', () => {
    expect(
      tournamentRegistryRowSchema.safeParse(makeRow({ origin: 'startgg' as never })).success,
    ).toBe(false);
    expect(
      tournamentRegistryRowSchema.safeParse(makeRow({ provider: 'parrygg' as never })).success,
    ).toBe(false);
  });

  it('rejects a provenance source other than research-import', () => {
    const row = makeRow({
      provenance: { source: 'sync' as never, importedAtMs: 1 },
    });
    expect(tournamentRegistryRowSchema.safeParse(row).success).toBe(false);
  });

  // The legacy-reader compatibility guarantee this contract is built on:
  // prep's `requireOwnedEntry` (a throwing `.parse`) and the recap share
  // read both parse stored entries with `tournamentEntrySchema` — a
  // projected row must therefore ALWAYS satisfy it, or those surfaces 500.
  it('every valid registry row also parses under the legacy tournamentEntrySchema', () => {
    const full = tournamentEntrySchema.safeParse(makeRow());
    expect(full.success).toBe(true);
    // Legacy parse strips the registry-only members (non-strict object)…
    expect(full.success && 'origin' in full.data).toBe(false);
    // …and keeps the legacy-required ones.
    expect(full.success ? full.data.setsPlayed : undefined).toBe(8);

    const minimal = tournamentEntrySchema.safeParse(
      tournamentRegistryRowSchema.parse({
        entryId: 'histimport:9',
        origin: 'admin-imported',
        provider: 'startgg',
        startggEventId: '9',
        eventName: 'start.gg event 9',
        playedSetCount: 0,
        provenance: { source: 'research-import', importedAtMs: 1 },
        registryWitness: 'research-import:v1:9',
        firstSetAt: 0,
        lastSetAt: 0,
        setsPlayed: 0,
      }),
    );
    expect(minimal.success).toBe(true);
  });

  it('never carries a legacy source member (no honest enum value exists for an import)', () => {
    // Deliberate contract fact rather than a schema mechanism: a stored
    // `source: 'admin-imported'` would fail every legacy safeParse, and any
    // existing enum member would be a lie. The deriver simply never writes
    // one; this pins the canonical fixture to that rule.
    expect('source' in makeRow()).toBe(false);
  });
});

describe('entryId/witness builders', () => {
  it('derives a deterministic, prefix-stable entryId and witness', () => {
    expect(buildTournamentRegistryEntryId('12345')).toBe('histimport:12345');
    expect(buildTournamentRegistryWitness('12345')).toBe('research-import:v1:12345');
    expect(
      buildTournamentRegistryEntryId('12345').startsWith(TOURNAMENT_REGISTRY_ENTRY_ID_PREFIX),
    ).toBe(true);
    expect(
      buildTournamentRegistryWitness('12345').startsWith(TOURNAMENT_REGISTRY_WITNESS_PREFIX),
    ).toBe(true);
  });
});

describe('isTournamentRegistryOwnedRow', () => {
  it('owns exactly a row carrying both the origin discriminator and a prefixed witness', () => {
    expect(isTournamentRegistryOwnedRow(makeRow())).toBe(true);
  });

  it('never owns legacy start.gg, parry.gg, or manual entries', () => {
    expect(
      isTournamentRegistryOwnedRow({
        eventId: 987,
        eventName: 'Ultimate Singles',
        firstSetAt: 1,
        lastSetAt: 2,
        setsPlayed: 5,
      }),
    ).toBe(false);
    expect(
      isTournamentRegistryOwnedRow({
        eventName: 'Ultimate Singles',
        firstSetAt: 1,
        lastSetAt: 2,
        setsPlayed: 2,
        source: 'parrygg',
      }),
    ).toBe(false);
    expect(
      isTournamentRegistryOwnedRow({
        eventName: 'Locals #42',
        firstSetAt: 1,
        lastSetAt: 1,
        setsPlayed: 0,
        source: 'manual',
      }),
    ).toBe(false);
  });

  it('never owns a row with a foreign witness prefix, a non-string witness, or a non-object value', () => {
    expect(isTournamentRegistryOwnedRow(makeRow({ registryWitness: 'someone-else:v1:1' }))).toBe(
      false,
    );
    expect(isTournamentRegistryOwnedRow({ ...makeRow(), registryWitness: 7 })).toBe(false);
    expect(isTournamentRegistryOwnedRow(null)).toBe(false);
    expect(isTournamentRegistryOwnedRow('histimport:1')).toBe(false);
    expect(isTournamentRegistryOwnedRow([makeRow()])).toBe(false);
  });

  it('never owns a row whose origin is absent even when a witness is present', () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- rest-destructure-to-omit idiom; `origin` is intentionally discarded
    const { origin: _origin, ...rest } = makeRow();
    expect(isTournamentRegistryOwnedRow(rest)).toBe(false);
  });
});

describe('tournamentRegistryListSchema', () => {
  it('accepts a mixed list of registry rows and legacy entries', () => {
    const legacy = {
      eventId: 987,
      eventName: 'Ultimate Singles',
      firstSetAt: 1_700_000_000_000,
      lastSetAt: 1_700_000_500_000,
      setsPlayed: 5,
      entryKey: '987',
    };
    const parsed = tournamentRegistryListSchema.parse([
      makeRow({ entryKey: 'histimport:100001' }),
      legacy,
    ]);
    expect(parsed).toHaveLength(2);
    // The registry member of the union must win for registry rows —
    // otherwise the legacy member would strip origin/provenance.
    expect(parsed[0]).toHaveProperty('origin', 'admin-imported');
    expect(parsed[1]).not.toHaveProperty('origin');
  });
});
