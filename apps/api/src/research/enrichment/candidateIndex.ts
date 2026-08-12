import type { Database } from 'firebase-admin/database';
import {
  providerSecondsToMs,
  researchSourceSetRecordSchema,
  type ResearchSourceSetRecord,
} from '@smash-tracker/shared';
import { isPathSafeTenantId } from '../subjectKind.js';
import { normalizeOpponentTag } from '../../startgg/sync.js';

/**
 * Phase 30.2 Plan 07 (ENR-05/ENR-06): a once-per-run, READ-ONLY index over
 * the Phase 30 start.gg provider tier (`researchSource/{tenantId}/sets`),
 * built for the deterministic entity-resolution ladder in `resolution.ts` to
 * query against.
 *
 * This module never mutates a provider record, performs no authorization of
 * its own (the route layer's `requireResearchTenantAdmin` in
 * `apps/api/src/routes/research.ts` is the single authorization site for
 * this family), and emits nothing.
 *
 * READ-ONLY SEAM (30.2-PATTERNS.md section 2): this module may `import type`
 * from `@smash-tracker/shared` and read `researchSource/{tenantId}/sets/*`
 * the same way `apps/api/src/research/migration/manifest.ts`'s
 * `enumerateRecords` walks a `nested-sets` tree, but it must NEVER import or
 * call a writer in `sourceLayer.ts`, `projection.ts`, `rollup.ts`, or
 * `backfillRun.ts`. Phase 30 ingestion behavior is locked by
 * `apps/api/src/research/lockedContracts.test.ts` and
 * `apps/api/src/startgg/researchQueryLock.test.ts` — those suites are
 * expected to fail loudly if this module ever crosses that seam.
 */

export interface CandidateSetEntry {
  targetSetId: string;
  /** Sorted, normalized competitor tags — the unordered pair key's members. Empty when the set has fewer/more than two resolvable entrants. */
  normalizedCompetitorPair: string[];
  /** VERBATIM entrant names, in `entrants` array order — never normalized (D-13). */
  rawCompetitorTags: (string | null)[];
  /** Per-entrant game-win tally, in `entrants` array order, tallied from `games[].winnerEntrantId`. Null when the set has other than two entrants or carries no game-level winner data. */
  scorePair: [number, number] | null;
  totalGames: number | null;
  completedAtMs: number | null;
  /** UTC calendar day (`YYYY-MM-DD`) derived from `completedAtMs`, or null when absent. */
  calendarDay: string | null;
  tournamentSlug: string | null;
  tournamentName: string | null;
  eventName: string | null;
  roundText: string | null;
  identifier: string | null;
}

export interface CandidateIndex {
  byTournamentSlug: Map<string, CandidateSetEntry[]>;
  byCompetitorPair: Map<string, CandidateSetEntry[]>;
  byCalendarDay: Map<string, CandidateSetEntry[]>;
  getByTargetSetId(targetSetId: string): CandidateSetEntry | undefined;
  /** Every indexed entry, for callers (the slug-less resolution path) that need the full candidate pool rather than one of the three keyed views. */
  all: CandidateSetEntry[];
  size: number;
  skippedCount: number;
}

export interface BuildCandidateIndexOptions {
  /** Caps the number of provider-tier records this build will read/index — defense in depth alongside the schema's own array-length caps. */
  maxSets?: number;
}

const DEFAULT_MAX_SETS = 20_000;

/**
 * `normalizeCompetitorTag` delegates to the SHIPPED `normalizeOpponentTag`
 * (`apps/api/src/startgg/sync.ts`) for its base normalization — sponsor-
 * prefix-via-pipe strip, lowercase, RTDB-illegal-character strip — and then
 * applies only two additional, documented steps on top of that result. This
 * module deliberately does NOT invent a second normalizer: if the
 * provider-side comparison and the Liquipedia-side comparison ever decided
 * "is this the same human" via two different functions, the two sides could
 * silently disagree about the same person (30.2-PATTERNS.md section 2, the
 * verbatim-tags rule).
 *
 * Step 1 (defensive/idempotent): strip a leading sponsor-prefix segment
 * terminated by a pipe. `normalizeOpponentTag` already takes the LAST
 * pipe-delimited segment, so this is a no-op for the ordinary
 * `"TEAM | Tag"` shape it already handles — it exists so a Liquipedia-side
 * raw tag that still carries a pipe survives to the same normal form.
 *
 * Step 2: strip a trailing parenthetical disambiguation suffix,
 * case-insensitively — Liquipedia disambiguates same-named players with a
 * trailing `(Something)` (`Light (American player)`, `Dany (American
 * player)`) that the start.gg side never carries (30.2-RESEARCH.md section
 * 6.2 item 5).
 */
export function normalizeCompetitorTag(raw: string): string {
  const base = normalizeOpponentTag(raw);
  const withoutLeadingPrefix = base.includes('|') ? (base.split('|').pop() ?? base).trim() : base;
  const withoutTrailingSuffix = withoutLeadingPrefix.replace(/\s*\([^)]*\)\s*$/i, '').trim();
  return withoutTrailingSuffix.length > 0 ? withoutTrailingSuffix : 'unknown';
}

/** Sorted, so the pair key is seat-order independent — an unordered comparison, never positional. */
export function buildCompetitorPairKey(a: string, b: string): string {
  return [a, b].sort().join('::');
}

function deriveCalendarDay(completedAtMs: number | null): string | null {
  if (completedAtMs === null) {
    return null;
  }
  const date = new Date(completedAtMs);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toISOString().slice(0, 10);
}

function tallyGameWins(
  record: ResearchSourceSetRecord,
  entrantIds: [string, string],
): [number, number] | null {
  if (!record.games || record.games.length === 0) {
    return null;
  }
  let wins0 = 0;
  let wins1 = 0;
  let sawAnyWinner = false;
  for (const game of record.games) {
    if (game.winnerEntrantId === entrantIds[0]) {
      wins0 += 1;
      sawAnyWinner = true;
    } else if (game.winnerEntrantId === entrantIds[1]) {
      wins1 += 1;
      sawAnyWinner = true;
    }
  }
  return sawAnyWinner ? [wins0, wins1] : null;
}

function buildEntry(record: ResearchSourceSetRecord): CandidateSetEntry {
  const targetSetId = record.storageKey ?? record.providerSetId;
  const entrants = record.entrants ?? [];
  const rawCompetitorTags = entrants.map((entrant) => entrant.name ?? null);
  const normalizedCompetitorPair =
    entrants.length === 2
      ? [
          normalizeCompetitorTag(entrants[0]!.name ?? ''),
          normalizeCompetitorTag(entrants[1]!.name ?? ''),
        ]
      : [];
  const scorePair =
    entrants.length === 2
      ? tallyGameWins(record, [entrants[0]!.entrantId, entrants[1]!.entrantId])
      : null;
  const completedAtMs = providerSecondsToMs(record.completedAt);

  return {
    targetSetId,
    normalizedCompetitorPair,
    rawCompetitorTags,
    scorePair,
    totalGames: record.totalGames ?? null,
    completedAtMs,
    calendarDay: deriveCalendarDay(completedAtMs),
    tournamentSlug: record.event?.tournamentSlug ?? null,
    tournamentName: record.event?.tournamentName ?? null,
    eventName: record.event?.name ?? null,
    roundText: record.fullRoundText ?? null,
    identifier: record.identifier ?? null,
  };
}

function pushToMap<K>(map: Map<K, CandidateSetEntry[]>, key: K, entry: CandidateSetEntry): void {
  const existing = map.get(key);
  if (existing) {
    existing.push(entry);
  } else {
    map.set(key, [entry]);
  }
}

/**
 * Builds the candidate index from ONE read of the tenant's provider set
 * tree — mirrors `apps/api/src/research/migration/manifest.ts`'s
 * `enumerateRecords` `nested-sets` shape (`researchSource/{tenantId}/sets`)
 * — with each child SAFE-PARSED independently, so one malformed record
 * skips (counted in `skippedCount`) rather than aborting the whole build.
 *
 * An unsafe `tenantId` returns an empty index and constructs no reference,
 * rather than throwing (guard-before-ref, the family-wide convention).
 */
export async function buildCandidateIndex(
  database: Database,
  tenantId: string,
  options: BuildCandidateIndexOptions = {},
): Promise<CandidateIndex> {
  const byTournamentSlug = new Map<string, CandidateSetEntry[]>();
  const byCompetitorPair = new Map<string, CandidateSetEntry[]>();
  const byCalendarDay = new Map<string, CandidateSetEntry[]>();
  const byTargetSetId = new Map<string, CandidateSetEntry>();
  const all: CandidateSetEntry[] = [];
  let skippedCount = 0;

  if (!isPathSafeTenantId(tenantId)) {
    return {
      byTournamentSlug,
      byCompetitorPair,
      byCalendarDay,
      getByTargetSetId: (targetSetId: string) => byTargetSetId.get(targetSetId),
      all,
      size: 0,
      skippedCount: 0,
    };
  }

  const maxSets = options.maxSets ?? DEFAULT_MAX_SETS;
  const snapshot = await database.ref(`researchSource/${tenantId}/sets`).get();
  const raw = snapshot.val() as Record<string, unknown> | null;

  if (raw !== null && typeof raw === 'object') {
    for (const value of Object.values(raw)) {
      if (all.length >= maxSets) {
        break;
      }
      const parsed = researchSourceSetRecordSchema.safeParse(value);
      if (!parsed.success) {
        skippedCount += 1;
        continue;
      }
      const entry = buildEntry(parsed.data);
      all.push(entry);
      byTargetSetId.set(entry.targetSetId, entry);

      if (entry.tournamentSlug !== null) {
        pushToMap(byTournamentSlug, entry.tournamentSlug, entry);
      }
      if (entry.normalizedCompetitorPair.length === 2) {
        const pairKey = buildCompetitorPairKey(
          entry.normalizedCompetitorPair[0]!,
          entry.normalizedCompetitorPair[1]!,
        );
        pushToMap(byCompetitorPair, pairKey, entry);
      }
      if (entry.calendarDay !== null) {
        pushToMap(byCalendarDay, entry.calendarDay, entry);
      }
    }
  }

  return {
    byTournamentSlug,
    byCompetitorPair,
    byCalendarDay,
    getByTargetSetId: (targetSetId: string) => byTargetSetId.get(targetSetId),
    all,
    size: all.length,
    skippedCount,
  };
}
