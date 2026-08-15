import {
  buildTournamentRegistryEntryId,
  buildTournamentRegistryWitness,
  isPathSafeProviderId,
  providerSecondsToMs,
  tournamentRegistryRowSchema,
  type ResearchSourceEntrant,
  type ResearchSourceSetRecord,
  type TournamentRegistryRow,
} from '@smash-tracker/shared';

/**
 * Phase 30.3 (Tournament Registry Backfill): the PURE half of the
 * historical-registry projector — a deterministic function from the stored
 * lossless source records (`researchSource/{uid}/sets/*`, exactly what the
 * Phase 30.1 migration copied onto the demo accounts) to the
 * admin-imported `tournamentEntries` rows the Tournaments tab reads. Never
 * touches a database, never mutates its input, and derives NOTHING that is
 * not present in the stored records:
 *
 * - Grouping key is the STABLE start.gg event id (`event.eventId`, falling
 *   back to the provenance `apiIds.eventId` the ingestion recorded from
 *   the same provider response).
 * - `playedSetCount` counts `complete` + `no-game-detail` sets only —
 *   `no-game-detail` is a set the provider reports as genuinely played
 *   with a real display score but no per-game rows (see
 *   `researchIngestion.ts`), while DQ/bye/walkover NEVER count as played
 *   (mirroring the legacy registry's own "non-DQ sets" semantics). A
 *   retained DQ is marked EXPLICITLY via `dqCount`; byes/walkovers/
 *   `no-game` sets contribute event metadata only.
 * - `non-ssbu` / `non-singles` / `unresolved` sets are excluded outright:
 *   an event evidenced only by sets the pipeline could not attribute to
 *   SSBU singles must not mint an SSBU registry row.
 * - The date range (`startAtMs`/`endAtMs`) spans PLAYED sets only —
 *   matching the legacy `firstSetAt`/`lastSetAt` definition ("earliest/
 *   latest processed set") so a late DQ never stretches the row past the
 *   last set actually played.
 * - Top standings are NEVER reconstructed: full event standings are not in
 *   a per-player set stream, so the member is simply absent.
 */

// ---------------------------------------------------------------------------
// Classification buckets
// ---------------------------------------------------------------------------

/** Classifications that evidence the tracked player's participation in an SSBU singles event. */
const INCLUDED_CLASSIFICATIONS = new Set([
  'complete',
  'no-game-detail',
  'no-game',
  'dq',
  'bye',
  'walkover',
]);

/** The subset of included classifications that count as a PLAYED set. */
const PLAYED_CLASSIFICATIONS = new Set(['complete', 'no-game-detail']);

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------

export interface TournamentRegistryDerivation {
  /** Derived rows, sorted by `entryId` — deterministic across runs. */
  rows: TournamentRegistryRow[];
  /** Included-classification sets with no event id anywhere on the record. */
  skippedNoEventId: number;
  /** Included-classification sets whose event id fails the RTDB key-safety predicate. */
  skippedUnsafeEventId: number;
  /** Sets excluded outright (`non-ssbu` / `non-singles` / `unresolved`). */
  skippedExcludedClassification: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function eventIdOf(record: ResearchSourceSetRecord): string | null {
  const fromEvent = record.event?.eventId;
  if (fromEvent != null && fromEvent.length > 0) {
    return fromEvent;
  }
  const fromApiIds = record.apiIds.eventId;
  return fromApiIds != null && fromApiIds.length > 0 ? fromApiIds : null;
}

function subjectEntrantOf(record: ResearchSourceSetRecord): ResearchSourceEntrant | undefined {
  if (record.subjectEntrantId == null) {
    return undefined;
  }
  return (record.entrants ?? []).find((entrant) => entrant.entrantId === record.subjectEntrantId);
}

/** Trimmed-or-absent: an empty/whitespace provider string is treated as absent, never stored. */
function nonEmpty(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed != null && trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Freshest-observation-first ordering: the ingestion stamps every record
 * with the fetch-snapshot `lastObservedAtMs` of the page that wrote it, so
 * sorting descending on it (provider set id ascending as the
 * deterministic tie-break) makes "first non-null wins" mean "the most
 * recently observed provider value wins" — a stable rule that survives a
 * re-run in any input order.
 */
function sortFreshestFirst(records: ResearchSourceSetRecord[]): ResearchSourceSetRecord[] {
  return [...records].sort((a, b) => {
    if (a.lastObservedAtMs !== b.lastObservedAtMs) {
      return b.lastObservedAtMs - a.lastObservedAtMs;
    }
    return a.providerSetId < b.providerSetId ? -1 : a.providerSetId > b.providerSetId ? 1 : 0;
  });
}

function firstDefined<T>(
  records: ResearchSourceSetRecord[],
  pick: (record: ResearchSourceSetRecord) => T | null | undefined,
): T | undefined {
  for (const record of records) {
    const value = pick(record);
    if (value !== null && value !== undefined) {
      return value;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

/**
 * Derives the full admin-imported registry row set for one workspace from
 * its stored source records. `importedAtMs` seeds `provenance.importedAtMs`
 * for rows that do not exist yet — the projector's apply step preserves an
 * EXISTING row's stamp instead (first-import semantics), which is what
 * makes a content-unchanged refresh a byte-identical no-op.
 */
export function deriveTournamentRegistryFromResearchSource(
  records: ResearchSourceSetRecord[],
  { importedAtMs }: { importedAtMs: number },
): TournamentRegistryDerivation {
  let skippedNoEventId = 0;
  let skippedUnsafeEventId = 0;
  let skippedExcludedClassification = 0;

  const byEventId = new Map<string, ResearchSourceSetRecord[]>();
  for (const record of records) {
    if (!INCLUDED_CLASSIFICATIONS.has(record.classification)) {
      skippedExcludedClassification += 1;
      continue;
    }
    const eventId = eventIdOf(record);
    if (eventId === null) {
      skippedNoEventId += 1;
      continue;
    }
    // Guard-before-key (house rule): the event id becomes part of the RTDB
    // child key, so an id carrying an RTDB-illegal character is skipped and
    // counted, never sanitized into a colliding key.
    if (!isPathSafeProviderId(eventId)) {
      skippedUnsafeEventId += 1;
      continue;
    }
    const group = byEventId.get(eventId);
    if (group) {
      group.push(record);
    } else {
      byEventId.set(eventId, [record]);
    }
  }

  const rows: TournamentRegistryRow[] = [];
  for (const [eventId, group] of byEventId) {
    const freshestFirst = sortFreshestFirst(group);

    const eventName =
      firstDefined(freshestFirst, (record) => nonEmpty(record.event?.name)) ??
      firstDefined(freshestFirst, (record) => nonEmpty(record.event?.slug)) ??
      `start.gg event ${eventId}`;
    const tournamentName = firstDefined(freshestFirst, (record) =>
      nonEmpty(record.event?.tournamentName),
    );
    const tournamentSlug = firstDefined(freshestFirst, (record) =>
      nonEmpty(record.event?.tournamentSlug),
    );
    const eventSlug = firstDefined(freshestFirst, (record) => nonEmpty(record.event?.slug));
    const numEntrants = firstDefined(freshestFirst, (record) => {
      const value = record.event?.numEntrants;
      return value != null && value > 0 ? value : undefined;
    });
    // `seedNum` is the provider's current seed member (the one the legacy
    // sync also reads); `initialSeedNum` is the pre-reseed fallback.
    const seed =
      firstDefined(freshestFirst, (record) => {
        const value = subjectEntrantOf(record)?.seedNum;
        return value != null && value > 0 ? value : undefined;
      }) ??
      firstDefined(freshestFirst, (record) => {
        const value = subjectEntrantOf(record)?.initialSeedNum;
        return value != null && value > 0 ? value : undefined;
      });
    const placement = firstDefined(freshestFirst, (record) => {
      const value = subjectEntrantOf(record)?.placement;
      return value != null && value > 0 ? value : undefined;
    });

    let playedSetCount = 0;
    let dqCount = 0;
    let startAtMs: number | undefined;
    let endAtMs: number | undefined;
    let asOfMs: number | undefined;
    for (const record of group) {
      asOfMs =
        asOfMs === undefined ? record.lastObservedAtMs : Math.max(asOfMs, record.lastObservedAtMs);
      if (record.classification === 'dq') {
        dqCount += 1;
      }
      if (!PLAYED_CLASSIFICATIONS.has(record.classification)) {
        continue;
      }
      playedSetCount += 1;
      const completedAtMs = providerSecondsToMs(record.completedAt);
      if (completedAtMs !== null && completedAtMs >= 0) {
        startAtMs = startAtMs === undefined ? completedAtMs : Math.min(startAtMs, completedAtMs);
        endAtMs = endAtMs === undefined ? completedAtMs : Math.max(endAtMs, completedAtMs);
      }
    }

    // Conditional-spread write shape (house RTDB null-stripping rule):
    // absent members are OMITTED, never null. The final parse is a loud
    // programming-bug tripwire — a derived row that violates its own
    // contract must fail HERE, not at a reader.
    rows.push(
      tournamentRegistryRowSchema.parse({
        entryId: buildTournamentRegistryEntryId(eventId),
        origin: 'admin-imported',
        provider: 'startgg',
        startggEventId: eventId,
        eventName,
        ...(tournamentName !== undefined ? { tournamentName } : {}),
        ...(tournamentSlug !== undefined ? { tournamentSlug } : {}),
        ...(eventSlug !== undefined ? { eventSlug } : {}),
        ...(startAtMs !== undefined ? { startAtMs } : {}),
        ...(endAtMs !== undefined ? { endAtMs } : {}),
        ...(numEntrants !== undefined ? { numEntrants } : {}),
        ...(seed !== undefined ? { seed } : {}),
        ...(placement !== undefined ? { placement } : {}),
        playedSetCount,
        ...(dqCount > 0 ? { dqCount } : {}),
        provenance: {
          source: 'research-import',
          importedAtMs,
          ...(asOfMs !== undefined ? { asOfMs } : {}),
        },
        registryWitness: buildTournamentRegistryWitness(eventId),
        // Legacy tournamentEntrySchema compatibility (see the shared
        // contract's doc): required members always present, `0` when the
        // provider reported no set timestamps at all.
        firstSetAt: startAtMs ?? 0,
        lastSetAt: endAtMs ?? 0,
        setsPlayed: playedSetCount,
        ...(tournamentSlug !== undefined ? { slug: tournamentSlug } : {}),
      } satisfies TournamentRegistryRow),
    );
  }

  rows.sort((a, b) => (a.entryId < b.entryId ? -1 : a.entryId > b.entryId ? 1 : 0));

  return { rows, skippedNoEventId, skippedUnsafeEventId, skippedExcludedClassification };
}
