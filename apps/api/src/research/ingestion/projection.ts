import type { Database } from 'firebase-admin/database';
import {
  isPathSafeProviderId,
  RESEARCH_PROJECTED_CLASSIFICATIONS,
  type MatchRecord,
  type ResearchSourceEntrant,
  type ResearchSourceSetRecord,
} from '@smash-tracker/shared';
import { normalizeOpponentTag } from '../../startgg/sync.js';
import { startggCharacterToFighterId } from '../../startgg/characterMap.js';
import { resolveStage } from '../../startgg/stageMap.js';
import { isPathSafeTenantId } from '../subjectKind.js';
import { ResearchIngestionWriteError } from './sourceLayer.js';

/**
 * Phase 30 Plan 03 (ING-03/ING-06, review C-H5/C-H6/C2-H5/C3-H2/C3-H3): the
 * legacy projection boundary. This module is the ONLY writer of
 * `matches/{tenantId}` and `opponents/{tenantId}` in the research ingestion
 * pipeline. `deriveLegacyProjection` is a pure derivation from ONE STORED
 * source record — never a second fetch, because a re-ingestion re-derives
 * from storage, not from a fresh API response. A `null` value in the update
 * map is an explicit deletion and never a stored null. User-authored
 * members survive every re-projection. It emits nothing.
 *
 * ING-03's structural guarantee ("only complete games project") holds
 * because this function refuses every classification but one
 * (`RESEARCH_PROJECTED_CLASSIFICATIONS`); ING-04's "excluded from win-rate
 * denominators" follows for free — a DQ, bye, or walkover simply has no
 * match row to count.
 */

// ---------------------------------------------------------------------------
// Member ownership partition (review C-H5, C2-H5, C3-H3, D-21)
// ---------------------------------------------------------------------------

/**
 * USER-OWNED. `deriveLegacyProjection` NEVER emits any of these — not even
 * an empty `notes` string — so the merge's preservation is unconditional,
 * never "unless `next` supplies it". The legacy builder this module
 * otherwise mirrors emits `notes: ''` unconditionally
 * (`apps/api/src/startgg/sync.ts:182`), which would make a preserved
 * `notes` entry dead code and overwrite every human note with an empty
 * string on every refresh — the exact defect this module's own tests assert
 * against by iterating this list against every emitted record.
 *
 * `vodUrl` belongs here per D-21 (review C3-H3 — REVERSES an earlier
 * cycle-2 draft that classified it provider-owned). The shipped service
 * classifies it explicitly (`apps/api/src/services/rtdb.ts:408-419`:
 * "User-owned annotations — `notes`, `vodUrl`, `vodTimestamps`, `gsp` — ...
 * stay editable on any match"), and the shipped edit surface reads and
 * submits it (`apps/web/src/components/match-form/EditMatchForm.tsx`).
 * Classifying it provider-owned on a research-projected row would DELETE,
 * on the next refresh, data a still-live UI accepts — an irreversible
 * user-data-loss path this plan has no authority to open. The rule,
 * implemented in `mergePreservedMatchMembers`'s FILL-EMPTY-ONLY branch: the
 * existing row's `vodUrl`, when present and non-empty, ALWAYS wins — a
 * provider change never overwrites it and a provider absence never deletes
 * it; when the existing row has none, the provider's value fills it. The
 * accepted, disclosed consequence: a human-entered URL can go stale
 * relative to the provider's, and this pipeline will not repair it (30-06's
 * Data Coverage panel and `30-COVERAGE-AUDIT.md` record the rule). The
 * supported way to record an ATTRIBUTED VOD reference is still an ING-08
 * `manual` supplement, which this module never reads and never writes.
 */
export const PRESERVED_MATCH_MEMBERS = [
  'vodStartSeconds',
  'vodTimestamps',
  'gsp',
  'tags',
  'notes',
  'vodUrl',
] as const;

/**
 * PROVIDER-OWNED. The merged value comes from `next`, and a member ABSENT
 * from `next` is REMOVED from the merged row — the ING-06 present->absent
 * correction case: a tournament name the provider stopped reporting
 * disappears here too, because preserving the old value would leave a
 * stale provider fact no future refresh could ever clear. Holds only
 * members this pipeline itself derives from provider data — after D-21,
 * `vodUrl` is not one of them. `source`/`externalId` are provider-owned the
 * same way, but are always set by the projection itself (this row IS
 * provider-derived) so they need no entry here.
 */
export const PROVIDER_REPLACED_MATCH_MEMBERS = [
  'eventName',
  'tournamentName',
  'roundText',
  'bracketRound',
  'opponentSeed',
  'opponentPlacement',
  'opponentUserSlug',
  'stocksLeft',
] as const;

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

export interface LegacyProjectionResult {
  /** `null` = explicit deletion of a stale projection. */
  matchUpdates: Record<string, MatchRecord | null>;
  /** Fill-empty-only candidates, NEVER on the emitted `MatchRecord` (D-21). */
  providerVodUrlByKey: Record<string, string>;
  opponentUpdates: Record<string, true>;
  /** The keys that now exist; written by `applyLegacyProjection`. */
  projectedMatchKeys: string[];
  namedGapDelta: {
    unknownCharacter: number;
    unknownStage: number;
    missingGameDetail: number;
    missingCompletedAt: number;
    unknownOnlineContext: number;
    unknownVideogame: number;
  };
  importedGames: number;
}

function emptyGapDelta(): LegacyProjectionResult['namedGapDelta'] {
  return {
    unknownCharacter: 0,
    unknownStage: 0,
    missingGameDetail: 0,
    missingCompletedAt: 0,
    unknownOnlineContext: 0,
    unknownVideogame: 0,
  };
}

function findEntrant(
  entrants: ResearchSourceEntrant[] | undefined,
  entrantId: string | null | undefined,
): ResearchSourceEntrant | undefined {
  if (entrantId == null) {
    return undefined;
  }
  return entrants?.find((entrant) => entrant.entrantId === entrantId);
}

/**
 * A pure function of ONE stored source record. Never reads the database,
 * never mutates its input.
 */
export function deriveLegacyProjection(record: ResearchSourceSetRecord): LegacyProjectionResult {
  const priorKeys = record.projectedMatchKeys ?? [];

  // ING-03's structural guarantee: this branch is what makes a
  // complete-to-DQ (or any non-projected) correction delete its rows.
  if (!(RESEARCH_PROJECTED_CLASSIFICATIONS as readonly string[]).includes(record.classification)) {
    const matchUpdates: Record<string, MatchRecord | null> = {};
    for (const key of priorKeys) {
      matchUpdates[key] = null;
    }
    return {
      matchUpdates,
      providerVodUrlByKey: {},
      opponentUpdates: {},
      projectedMatchKeys: [],
      namedGapDelta: {
        ...emptyGapDelta(),
        missingGameDetail: record.classification === 'no-game-detail' ? 1 : 0,
        missingCompletedAt: record.completedAt == null ? 1 : 0,
        unknownOnlineContext: record.event?.isOnline == null ? 1 : 0,
        unknownVideogame: record.event?.videogameId == null ? 1 : 0,
      },
      importedGames: 0,
    };
  }

  const storageKey = record.storageKey ?? record.providerSetId;
  const entrants = record.entrants ?? [];
  const subjectEntrant = findEntrant(entrants, record.subjectEntrantId);
  const opponentEntrant = findEntrant(entrants, record.opponentEntrantId);

  const matchUpdates: Record<string, MatchRecord | null> = {};
  const providerVodUrlByKey: Record<string, string> = {};
  const namedGapDelta = emptyGapDelta();
  namedGapDelta.unknownOnlineContext = record.event?.isOnline == null ? 1 : 0;

  const matchType = record.event?.isOnline ? 'online-tourney' : 'offline-tourney';
  const eventName = record.event?.name?.trim();
  const tournamentName = record.event?.tournamentName?.trim();
  const roundText = record.fullRoundText?.trim();
  const bracketRound = typeof record.round === 'number' ? record.round : undefined;
  const opponentTag = normalizeOpponentTag(opponentEntrant?.name);
  const opponentSeed = opponentEntrant?.seedNum ?? undefined;
  const opponentPlacement = opponentEntrant?.placement ?? undefined;
  const opponentUserSlug = opponentEntrant?.participants?.find((p) => p.userSlug != null)?.userSlug;

  // Positional score mapping (mirrors `startgg/sync.ts`): `entrant1Score`/
  // `entrant2Score` correspond to `entrants[0]`/`entrants[1]` by ARRAY
  // POSITION, never by entrant id — the provider exposes no per-score
  // entrant id.
  const subjectSlotIndex = subjectEntrant
    ? entrants.findIndex((entrant) => entrant.entrantId === subjectEntrant.entrantId)
    : -1;
  const opponentSlotIndex = opponentEntrant
    ? entrants.findIndex((entrant) => entrant.entrantId === opponentEntrant.entrantId)
    : -1;

  const games = record.games ?? [];
  const completedAtMs = (record.completedAt ?? 0) * 1_000;

  games.forEach((game, index) => {
    const selections = game.selections ?? [];
    const subjectSelection = subjectEntrant
      ? selections.find((selection) => selection.entrantId === subjectEntrant.entrantId)
      : undefined;
    const opponentSelection = opponentEntrant
      ? selections.find((selection) => selection.entrantId === opponentEntrant.entrantId)
      : undefined;

    if (
      game.winnerEntrantId == null ||
      subjectSelection?.characterId == null ||
      opponentSelection?.characterId == null
    ) {
      namedGapDelta.missingGameDetail += 1;
      return;
    }

    const subjectCharacterId = Number(subjectSelection.characterId);
    const opponentCharacterId = Number(opponentSelection.characterId);
    const fighterId = startggCharacterToFighterId.get(subjectCharacterId);
    const opponentFighterId = startggCharacterToFighterId.get(opponentCharacterId);
    if (fighterId === undefined || opponentFighterId === undefined) {
      namedGapDelta.unknownCharacter += 1;
      return;
    }

    const rawStageId = game.stageId;
    const stageId =
      typeof rawStageId === 'number'
        ? rawStageId
        : typeof rawStageId === 'string'
          ? Number(rawStageId)
          : null;
    const resolvedStage = resolveStage(
      stageId != null && Number.isFinite(stageId) ? stageId : null,
      game.stageName,
    );
    if (!resolvedStage) {
      namedGapDelta.unknownStage += 1;
    }

    const win = game.winnerEntrantId === subjectEntrant?.entrantId;
    const winnerScore =
      game.winnerEntrantId === subjectEntrant?.entrantId
        ? subjectSlotIndex === 0
          ? game.entrant1Score
          : game.entrant2Score
        : game.winnerEntrantId === opponentEntrant?.entrantId
          ? opponentSlotIndex === 0
            ? game.entrant1Score
            : game.entrant2Score
          : null;
    const stocksLeft =
      typeof winnerScore === 'number' && winnerScore >= 0 && winnerScore <= 3
        ? winnerScore
        : undefined;

    const key = `sgg-${storageKey}-g${index + 1}`;
    const externalId = `sgg:${record.providerSetId}:g${index + 1}`;

    // Never `vodUrl` on the emitted record (D-21, review C3-H3) — the
    // provider's URL travels on its own fill-empty-only channel.
    if (record.vodUrl) {
      providerVodUrlByKey[key] = record.vodUrl;
    }

    matchUpdates[key] = {
      fighter_id: fighterId,
      opponent_id: opponentFighterId,
      time: completedAtMs,
      map: resolvedStage
        ? { id: resolvedStage.id, name: resolvedStage.name }
        : { id: 0, name: 'unknown' },
      opponent: opponentTag,
      matchType,
      win,
      source: 'startgg',
      externalId,
      ...(eventName ? { eventName } : {}),
      ...(tournamentName ? { tournamentName } : {}),
      ...(roundText ? { roundText } : {}),
      ...(bracketRound !== undefined ? { bracketRound } : {}),
      ...(opponentSeed != null ? { opponentSeed } : {}),
      ...(opponentPlacement != null ? { opponentPlacement } : {}),
      ...(opponentUserSlug ? { opponentUserSlug } : {}),
      ...(stocksLeft !== undefined ? { stocksLeft } : {}),
    };
  });

  const newKeys = Object.keys(matchUpdates);
  for (const priorKey of priorKeys) {
    if (!(priorKey in matchUpdates)) {
      matchUpdates[priorKey] = null;
    }
  }

  const opponentUpdates: Record<string, true> = newKeys.length > 0 ? { [opponentTag]: true } : {};

  return {
    matchUpdates,
    providerVodUrlByKey,
    opponentUpdates,
    projectedMatchKeys: newKeys,
    namedGapDelta,
    importedGames: newKeys.length,
  };
}

// ---------------------------------------------------------------------------
// Preservation merge
// ---------------------------------------------------------------------------

type PreservedMember = (typeof PRESERVED_MATCH_MEMBERS)[number];

/**
 * On a research-projected row, a research projection replaces everything
 * start.gg said and preserves everything a human said — and after D-21,
 * `vodUrl` counts as something a HUMAN may have said, so the provider may
 * only fill it when it is empty. Second-order effect, stated honestly:
 * `vodTimestamps` and `vodStartSeconds` are preserved even when the URL they
 * annotate is a human's rather than the provider's, which is exactly what
 * the VOD loop needs.
 *
 * `vodTimestamps` is carried OPAQUELY off the RAW existing node — never
 * through a parsed/normalized copy — mirroring
 * `apps/api/src/services/rtdb.ts:649-660`'s exact reasoning: the shared
 * schema's `vodTimestamps` field is a preprocessor that always reshapes the
 * node into a flat, id-bearing array, so carrying a parsed copy would
 * silently flatten a keyed push-key subtree and destroy the note ids the
 * coaching note-cap transaction depends on.
 */
export function mergePreservedMatchMembers(
  existingRaw: unknown,
  next: MatchRecord,
  providerVodUrl?: string,
): MatchRecord {
  const existing =
    existingRaw !== null && existingRaw !== undefined && typeof existingRaw === 'object'
      ? (existingRaw as Record<string, unknown>)
      : undefined;

  const existingVodUrl =
    existing && typeof existing.vodUrl === 'string' && existing.vodUrl.length > 0
      ? existing.vodUrl
      : undefined;
  // FILL-EMPTY-ONLY (review C3-H3, D-21): an existing non-empty value always
  // wins over a provider change OR a provider absence; the provider only
  // ever fills a member that is empty on both sides.
  const resolvedVodUrl =
    existingVodUrl ?? (providerVodUrl && providerVodUrl.length > 0 ? providerVodUrl : undefined);

  const preservedEntries: Partial<Record<PreservedMember, unknown>> = {};
  if (existing) {
    if (existing.vodStartSeconds !== undefined) {
      preservedEntries.vodStartSeconds = existing.vodStartSeconds;
    }
    if (existing.vodTimestamps !== undefined) {
      preservedEntries.vodTimestamps = existing.vodTimestamps;
    }
    if (existing.gsp !== undefined) {
      preservedEntries.gsp = existing.gsp;
    }
    if (existing.tags !== undefined) {
      preservedEntries.tags = existing.tags;
    }
    if (existing.notes !== undefined) {
      preservedEntries.notes = existing.notes;
    }
  }
  if (resolvedVodUrl !== undefined) {
    preservedEntries.vodUrl = resolvedVodUrl;
  }

  return {
    ...next,
    ...(preservedEntries as Partial<MatchRecord>),
  };
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

/**
 * Writes each row it is CREATING or UPDATING through its OWN `.transaction()`
 * on `matches/{tenantId}/{key}` (review C3-H2): the merge therefore runs
 * against the value RTDB actually holds at COMMIT time, so an annotation
 * child write that lands mid-projection is re-merged by the retried
 * callback instead of being erased by a stale whole-row write. Then writes
 * the deletions, the opponent rows and the source record's
 * `projectedMatchKeys` child in ONE multi-path update. Writes nothing at
 * all when there is nothing to write.
 *
 * ORDERING AND ITS CRASH-RECOVERY CONSEQUENCE (review C-H6 as revised by
 * C3-H2): the index write FOLLOWS the row transactions. They are no longer
 * one atomic unit — making them one is what forced the whole-row
 * read-merge-write that erased concurrent annotations, and the trade is
 * deliberate. A failure or crash between the two is HEALED BY THE NEXT
 * PROJECTION PASS over the same source record: the pass re-derives the
 * identical key set, re-writes the rows idempotently, and writes the index.
 * The one residual, stated precisely rather than hidden: if a PROCESS DEATH
 * lands between the row transactions and the index update, AND the very
 * next observation of that set produces a SMALLER key set (a
 * complete-to-DQ correction, or fewer games), the rows written but never
 * indexed are not found for deletion and survive as orphans. Every key the
 * index DOES name is always cleaned; the exposure is bounded to keys
 * written in the final unindexed window. This is why no separate scoped
 * writer for the index exists: it has exactly one writer, and it is the
 * multi-path update below.
 */
export async function applyLegacyProjection(
  database: Database,
  tenantId: string,
  storageKey: string,
  result: LegacyProjectionResult,
): Promise<void> {
  if (!isPathSafeTenantId(tenantId) || !isPathSafeProviderId(storageKey)) {
    return;
  }

  const rowWrites: [string, MatchRecord][] = [];
  const deletionKeys: string[] = [];
  for (const [key, value] of Object.entries(result.matchUpdates)) {
    if (!isPathSafeProviderId(key)) {
      // An unsafe match key is SKIPPED, never thrown on — a deterministic
      // key derived from an already-safe storage key should never be
      // unsafe in practice; this guard is defense in depth.
      continue;
    }
    if (value === null) {
      deletionKeys.push(key);
    } else {
      rowWrites.push([key, value]);
    }
  }

  const opponentTags = Object.keys(result.opponentUpdates);
  const hasAnyChange = rowWrites.length > 0 || deletionKeys.length > 0 || opponentTags.length > 0;
  if (!hasAnyChange) {
    return;
  }

  try {
    // Deletions need no merge and therefore no transaction — only rows
    // being CREATED or UPDATED go through the per-row transaction below.
    for (const [key, value] of rowWrites) {
      const providerVodUrl = result.providerVodUrlByKey[key];
      await database
        .ref(`matches/${tenantId}/${key}`)
        .transaction((existingRaw) =>
          mergePreservedMatchMembers(existingRaw, value, providerVodUrl),
        );
    }
  } catch (cause) {
    throw new ResearchIngestionWriteError(
      'Failed to write a projected match row',
      `matches/${tenantId}`,
      cause,
    );
  }

  const writes: Record<string, unknown> = {};
  for (const key of deletionKeys) {
    writes[`matches/${tenantId}/${key}`] = null;
  }
  for (const tag of opponentTags) {
    writes[`opponents/${tenantId}/${tag}`] = true;
  }
  writes[`researchSource/${tenantId}/sets/${storageKey}/projectedMatchKeys`] =
    result.projectedMatchKeys.length > 0 ? result.projectedMatchKeys : null;

  try {
    await database.ref().update(writes);
  } catch (cause) {
    throw new ResearchIngestionWriteError(
      'Failed to write projection deletions, opponent rows, and the projected-key index',
      `researchSource/${tenantId}/sets/${storageKey}/projectedMatchKeys`,
      cause,
    );
  }
}
