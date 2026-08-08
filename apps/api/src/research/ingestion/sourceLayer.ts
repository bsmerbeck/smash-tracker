import { createHash } from 'node:crypto';
import type { Database } from 'firebase-admin/database';
import {
  isPathSafeProviderId,
  researchSourceSetRecordSchema,
  type ResearchApiIds,
  type ResearchSetClassification,
  type ResearchSourceEntrant,
  type ResearchSourceEvent,
  type ResearchSourceGame,
  type ResearchSourceGameSelection,
  type ResearchSourceParticipant,
  type ResearchSourceSetRecord,
} from '@smash-tracker/shared';
import type { StartggResearchSet } from '../../startgg/client.js';
import { isPathSafeTenantId } from '../subjectKind.js';
import type { ResearchSetClassificationResult } from './classification.js';

/**
 * Phase 30 Plan 03 (ING-03/ING-06, review C-H6/C-H9a/C2-H2/C2-A7/C3-H4a/
 * C3-H5/C3-A5): the lossless source tier. This module is the ONLY writer of
 * `researchSource`, performs NO authorization of its own (the route guard is
 * the single authorization site — same contract as `research/tenants.ts`),
 * emits NOTHING, and never writes to `matches` — that is `projection.ts`'s
 * job alone.
 *
 * The projected-key index (`researchSource/{tenantId}/sets/{storageKey}/
 * projectedMatchKeys`) has exactly one writer, and it is the projection's
 * atomic multi-path update (`applyLegacyProjection`, Task 3) — this module
 * deliberately exposes no scoped writer for that child. Two separate
 * durable writes would leave a window in which matches exist with no
 * deletion index and the cursor has already advanced past them (review
 * C-H6); this module's upsert only ever CARRIES the existing
 * `projectedMatchKeys` value forward unchanged, it never decides a new one.
 */

// ---------------------------------------------------------------------------
// Provider-field extraction
// ---------------------------------------------------------------------------

export interface ResearchSourceProviderFields {
  providerSetId: string;
  apiIds: ResearchApiIds;
  classification: ResearchSetClassification;
  ruleId: string;
  subjectEntrantId?: string;
  opponentEntrantId?: string;
  state?: number;
  completedAt?: number;
  createdAt?: number;
  updatedAt?: number;
  fullRoundText?: string;
  round?: number;
  displayScore?: string;
  totalGames?: number;
  vodUrl?: string;
  identifier?: string;
  event?: ResearchSourceEvent;
  entrants?: ResearchSourceEntrant[];
  games?: ResearchSourceGame[];
}

type ResearchEntrant = NonNullable<NonNullable<StartggResearchSet['slots']>[number]>['entrant'];
type ResearchGame = NonNullable<StartggResearchSet['games']>[number];

/** Every non-null entrant across the set's slots, SLOT ORDER preserved — positional order is load-bearing for per-game scores (mirrors `startgg/sync.ts`). */
function nonNullEntrants(set: StartggResearchSet): NonNullable<ResearchEntrant>[] {
  return (set.slots ?? []).flatMap((slot) => (slot?.entrant ? [slot.entrant] : []));
}

function buildApiIds(
  set: StartggResearchSet,
  entrants: NonNullable<ResearchEntrant>[],
): ResearchApiIds {
  const entrantIds = entrants.map((entrant) => String(entrant.id));
  const playerIds = Array.from(
    new Set(
      entrants.flatMap((entrant) =>
        (entrant.participants ?? []).flatMap((participant) =>
          participant?.player?.id != null ? [String(participant.player.id)] : [],
        ),
      ),
    ),
  );
  return {
    setId: String(set.id),
    ...(set.event?.id != null ? { eventId: String(set.event.id) } : {}),
    ...(set.event?.tournament?.id != null ? { tournamentId: String(set.event.tournament.id) } : {}),
    ...(entrantIds.length > 0 ? { entrantIds } : {}),
    ...(playerIds.length > 0 ? { playerIds } : {}),
  };
}

function buildEvent(set: StartggResearchSet): ResearchSourceEvent | undefined {
  const event = set.event;
  if (!event) {
    return undefined;
  }
  return {
    ...(event.id != null ? { eventId: String(event.id) } : {}),
    ...(event.name != null ? { name: event.name } : {}),
    ...(event.slug != null ? { slug: event.slug } : {}),
    ...(event.isOnline != null ? { isOnline: event.isOnline } : {}),
    ...(event.numEntrants != null ? { numEntrants: event.numEntrants } : {}),
    ...(event.type != null ? { eventType: String(event.type) } : {}),
    ...(event.videogame?.id != null ? { videogameId: String(event.videogame.id) } : {}),
    ...(event.tournament?.id != null ? { tournamentId: String(event.tournament.id) } : {}),
    ...(event.tournament?.name != null ? { tournamentName: event.tournament.name } : {}),
    ...(event.tournament?.slug != null ? { tournamentSlug: event.tournament.slug } : {}),
  };
}

function buildParticipants(
  participants: NonNullable<ResearchEntrant>['participants'],
): ResearchSourceParticipant[] {
  return (participants ?? []).flatMap((participant) => {
    if (!participant) {
      return [];
    }
    return [
      {
        ...(participant.player?.id != null ? { playerId: String(participant.player.id) } : {}),
        // VERBATIM, sponsor prefix intact (D-13) — normalization happens only
        // at the legacy projection boundary (`normalizeOpponentTag`).
        ...(participant.player?.gamerTag != null ? { gamerTag: participant.player.gamerTag } : {}),
        ...(participant.user?.slug != null ? { userSlug: participant.user.slug } : {}),
      },
    ];
  });
}

function buildEntrant(entrant: NonNullable<ResearchEntrant>): ResearchSourceEntrant {
  const seedNum = entrant.seeds?.find((seed) => typeof seed?.seedNum === 'number')?.seedNum;
  const participants = buildParticipants(entrant.participants);
  return {
    entrantId: String(entrant.id),
    // VERBATIM, sponsor prefix intact (D-13).
    ...(entrant.name != null ? { name: entrant.name } : {}),
    ...(entrant.isDisqualified != null ? { isDisqualified: entrant.isDisqualified } : {}),
    ...(entrant.initialSeedNum != null ? { initialSeedNum: entrant.initialSeedNum } : {}),
    ...(seedNum != null ? { seedNum } : {}),
    ...(entrant.standing?.placement != null ? { placement: entrant.standing.placement } : {}),
    ...(participants.length > 0 ? { participants } : {}),
  };
}

function buildGameSelections(
  selections: ResearchGame['selections'],
): ResearchSourceGameSelection[] {
  return (selections ?? []).map((selection) => ({
    ...(selection.entrant?.id != null ? { entrantId: String(selection.entrant.id) } : {}),
    ...(selection.character?.id != null ? { characterId: selection.character.id } : {}),
  }));
}

function buildGame(game: ResearchGame): ResearchSourceGame {
  const selections = buildGameSelections(game.selections);
  return {
    ...(game.id != null ? { gameId: game.id } : {}),
    ...(game.winnerId != null ? { winnerEntrantId: String(game.winnerId) } : {}),
    ...(game.stage?.id != null ? { stageId: game.stage.id } : {}),
    ...(game.stage?.name != null ? { stageName: game.stage.name } : {}),
    ...(selections.length > 0 ? { selections } : {}),
    ...(game.entrant1Score != null ? { entrant1Score: game.entrant1Score } : {}),
    ...(game.entrant2Score != null ? { entrant2Score: game.entrant2Score } : {}),
  };
}

/**
 * The boundary where the raw GraphQL shape becomes the stored shape.
 * Normalizes every provider ID to a string, keeps entrant `name` and
 * participant `gamerTag` VERBATIM with sponsor prefixes intact (D-13), maps
 * slots to a flat `entrants` array preserving slot order, maps `games`
 * preserving array order, and folds `event`/`tournament` identity into
 * `researchSourceEventSchema`'s flat shape. Carries `classification` and
 * `ruleId` through from the classifier's own decision — this function never
 * re-decides eligibility, it only shapes what the classifier already
 * decided. Never invents a value for an absent field.
 */
export function toProviderFields(
  set: StartggResearchSet,
  classification: ResearchSetClassificationResult,
): ResearchSourceProviderFields {
  const entrants = nonNullEntrants(set);
  const games = set.games ?? [];
  const event = buildEvent(set);

  return {
    providerSetId: String(set.id),
    apiIds: buildApiIds(set, entrants),
    classification: classification.classification,
    ruleId: classification.ruleId,
    ...(classification.subjectEntrantId != null
      ? { subjectEntrantId: classification.subjectEntrantId }
      : {}),
    ...(classification.opponentEntrantId != null
      ? { opponentEntrantId: classification.opponentEntrantId }
      : {}),
    ...(set.state != null ? { state: set.state } : {}),
    ...(set.completedAt != null ? { completedAt: set.completedAt } : {}),
    ...(set.createdAt != null ? { createdAt: set.createdAt } : {}),
    ...(set.updatedAt != null ? { updatedAt: set.updatedAt } : {}),
    ...(set.fullRoundText != null ? { fullRoundText: set.fullRoundText } : {}),
    ...(set.round != null ? { round: set.round } : {}),
    ...(set.displayScore != null ? { displayScore: set.displayScore } : {}),
    ...(set.totalGames != null ? { totalGames: set.totalGames } : {}),
    ...(set.vodUrl != null ? { vodUrl: set.vodUrl } : {}),
    ...(set.identifier != null ? { identifier: set.identifier } : {}),
    ...(event ? { event } : {}),
    ...(entrants.length > 0 ? { entrants: entrants.map(buildEntrant) } : {}),
    ...(games.length > 0 ? { games: games.map(buildGame) } : {}),
  };
}

// ---------------------------------------------------------------------------
// Fingerprint + derived-safe storage key
// ---------------------------------------------------------------------------

/** Recursively sorts object keys and drops null/undefined members, so two objects with the same members in different insertion/omission order produce the same string. */
function stableStringify(value: unknown): string {
  if (value === null || value === undefined) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== null && entryValue !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * A deterministic serialization of every PROVIDER-OWNED member — provenance
 * and bookkeeping members are excluded by construction because they are not
 * part of `ResearchSourceProviderFields`. This is the sole mechanism by
 * which a re-run distinguishes a provider correction (which increments
 * `corrected`) from an unchanged re-observation (which does not).
 */
export function providerContentFingerprint(fields: ResearchSourceProviderFields): string {
  return createHash('sha256').update(stableStringify(fields)).digest('hex');
}

/**
 * Solves the "every discovered provider set lands in the source layer"
 * absolute for a provider id that is not a legal RTDB key (review C2-A7).
 * An earlier draft made an undocumented exception for this case — it
 * counted a gap and wrote NOTHING, so the record itself was lost. A digest
 * key is path-safe by construction (letters and digits only, so
 * `isPathSafeProviderId` accepts it), is deterministic across runs so
 * re-ingestion converges on the same node, and preserves the raw id in the
 * record's own `providerSetId` member, which is where every audit and every
 * human read looks. Real start.gg set ids are numeric strings, so this path
 * is expected to be dead in practice — its value is that the guarantee
 * stops being conditional.
 */
export function deriveSafeProviderKey(rawProviderId: string): string {
  return `pk-${createHash('sha256').update(rawProviderId).digest('hex').slice(0, 32)}`;
}

// ---------------------------------------------------------------------------
// Stored-shape builder + upsert
// ---------------------------------------------------------------------------

export interface BuildStoredSourceSetInput {
  /** The RAW provider id, always. */
  providerSetId: string;
  /** The RTDB child key: equal to `providerSetId`, or a derived-safe digest. */
  storageKey: string;
  keyDerived: boolean;
  fields: ResearchSourceProviderFields;
  fingerprint: string;
  baselineFingerprint: string | null;
  ingestionRunId: string;
  /** The CONTRIBUTING page, carried forward on a non-contributing write. */
  ingestionPage: number;
  /** Written on create, carried forward verbatim thereafter. */
  firstIngestionPlayerId: string;
  fetchedAtMs: number;
  lastObservedAtMs: number;
  projectedMatchKeys: string[];
}

/**
 * Conditional-spreads EVERY provider-owned member individually — an absent
 * member is OMITTED from the returned object, never written as a bare
 * null. Because a `.transaction()` return replaces the WHOLE node, that
 * omission IS the deletion D-09 requires.
 */
export function buildStoredSourceSet(input: BuildStoredSourceSetInput): Record<string, unknown> {
  const { fields } = input;
  return {
    providerSetId: input.providerSetId,
    apiIds: fields.apiIds,
    ingestionRunId: input.ingestionRunId,
    ingestionPage: input.ingestionPage,
    firstIngestionPlayerId: input.firstIngestionPlayerId,
    fetchedAtMs: input.fetchedAtMs,
    lastObservedAtMs: input.lastObservedAtMs,
    classification: fields.classification,
    ruleId: fields.ruleId,
    contentFingerprint: input.fingerprint,
    ...(fields.subjectEntrantId !== undefined ? { subjectEntrantId: fields.subjectEntrantId } : {}),
    ...(fields.opponentEntrantId !== undefined
      ? { opponentEntrantId: fields.opponentEntrantId }
      : {}),
    ...(fields.state !== undefined ? { state: fields.state } : {}),
    ...(fields.completedAt !== undefined ? { completedAt: fields.completedAt } : {}),
    ...(fields.createdAt !== undefined ? { createdAt: fields.createdAt } : {}),
    ...(fields.updatedAt !== undefined ? { updatedAt: fields.updatedAt } : {}),
    ...(fields.fullRoundText !== undefined ? { fullRoundText: fields.fullRoundText } : {}),
    ...(fields.round !== undefined ? { round: fields.round } : {}),
    ...(fields.displayScore !== undefined ? { displayScore: fields.displayScore } : {}),
    ...(fields.totalGames !== undefined ? { totalGames: fields.totalGames } : {}),
    ...(fields.vodUrl !== undefined ? { vodUrl: fields.vodUrl } : {}),
    ...(fields.identifier !== undefined ? { identifier: fields.identifier } : {}),
    ...(fields.event !== undefined ? { event: fields.event } : {}),
    ...(fields.entrants !== undefined ? { entrants: fields.entrants } : {}),
    ...(fields.games !== undefined ? { games: fields.games } : {}),
    ...(input.projectedMatchKeys.length > 0
      ? { projectedMatchKeys: input.projectedMatchKeys }
      : {}),
    ...(input.baselineFingerprint !== null
      ? { baselineFingerprint: input.baselineFingerprint }
      : {}),
    ...(input.keyDerived ? { storageKey: input.storageKey, providerKeyDerived: true } : {}),
  };
}

export type UpsertSourceSetOutcome =
  'created' | 'replaced-unchanged' | 'replaced-changed' | 'rejected-key' | 'stale-write-skipped';

export interface UpsertSourceSetResult {
  outcome: UpsertSourceSetOutcome;
  storageKey: string | null;
  keyDerived: boolean;
  /** The ONE attempt-invariant contribution verdict (review C3-H4a). */
  contributes: boolean;
  /** This run's player id owns the set for rollup purposes (review C3-A5). */
  uniqueToTenant: boolean;
  firstIngestionPlayerId: string | null;
  previousProjectedMatchKeys: string[];
  previousClassification: ResearchSetClassification | null;
  previousIngestionRunId: string | null;
  previousIngestionPage: number | null;
  previousFingerprint: string | null;
  baselineFingerprint: string | null;
  fingerprint: string | null;
}

/**
 * Thrown for a rejected DATABASE write — an INFRASTRUCTURE fact about the
 * whole page, distinct from an unsafe key (a DATA fact about one record
 * reported as an outcome, never thrown). Conflating the two is what let a
 * failed write be counted as an unresolved record while the cursor moved
 * past it (review C-H6).
 */
export class ResearchIngestionWriteError extends Error {
  constructor(
    message: string,
    readonly path: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ResearchIngestionWriteError';
  }
}

function parseSourceRecord(raw: unknown): ResearchSourceSetRecord | null {
  if (raw === null || raw === undefined) {
    return null;
  }
  const parsed = researchSourceSetRecordSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export interface UpsertResearchSourceSetInput {
  tenantId: string;
  providerSetId: string;
  fields: ResearchSourceProviderFields;
  ingestionRunId: string;
  playerId: string;
  page: number;
  /**
   * The timestamp of the PAGE ATTEMPT's fetch resolution, captured ONCE per
   * attempt and passed unchanged for every set on that page — never a clock
   * read per set, and never the moment of the write (review C3-H5). The
   * stale-write guard below only orders two OBSERVATIONS if this value
   * describes when the data was fetched; a write clock would make a slow
   * stale holder look newer than the fresh holder it is about to regress.
   */
  fetchedSnapshotAtMs: number;
}

function rejectedKeyResult(): UpsertSourceSetResult {
  return {
    outcome: 'rejected-key',
    storageKey: null,
    keyDerived: false,
    contributes: false,
    uniqueToTenant: false,
    firstIngestionPlayerId: null,
    previousProjectedMatchKeys: [],
    previousClassification: null,
    previousIngestionRunId: null,
    previousIngestionPage: null,
    previousFingerprint: null,
    baselineFingerprint: null,
    fingerprint: null,
  };
}

/**
 * Upserts one provider set's source-tier record with replace-not-merge
 * semantics (D-09). See the module header for the three consumer rules the
 * caller (plan 30-07) must read directly off the returned result rather
 * than re-derive:
 *
 * - The executor counts a set's per-set contribution exactly when the
 *   returned `contributes` is true. It READS that member; it does not
 *   recompute the predicate from `previousIngestionRunId`/
 *   `previousIngestionPage`, because the store is the only place that can
 *   apply the carry-forward rule and a second copy of the predicate would
 *   drift from it (review C3-H4a).
 * - The executor counts a set into the run's UNIQUE bundle exactly when
 *   `contributes` AND `uniqueToTenant` are both true (review C3-A5).
 * - The executor counts `corrected` exactly when `baselineFingerprint` is
 *   non-null and differs from `fingerprint` — never from the outcome alone
 *   (review C2-H2).
 */
export async function upsertResearchSourceSet(
  database: Database,
  input: UpsertResearchSourceSetInput,
): Promise<UpsertSourceSetResult> {
  // STEP ZERO (review C-H1): a tenant id is `subjectKind.ts`'s concern —
  // guarding it here too would create a second definition to keep in sync.
  // On false, return `rejected-key` BEFORE constructing any reference, and
  // never throw.
  if (!isPathSafeTenantId(input.tenantId)) {
    return rejectedKeyResult();
  }

  // Resolve the STORAGE KEY (review C2-A7): when the raw provider id is
  // path-safe the storage key IS the raw id; otherwise it is a derived-safe
  // digest. Either way the record is written — an unsafe provider id is no
  // longer a non-write, it is a storage-key substitution the caller counts
  // as the `unsafeProviderKey` named gap so the boundary stays visible, and
  // the raw id survives verbatim in `providerSetId`.
  const keyDerived = !isPathSafeProviderId(input.providerSetId);
  const storageKey = keyDerived ? deriveSafeProviderKey(input.providerSetId) : input.providerSetId;

  // Pre-generated ONCE, outside the transaction callback (CR-01) — the
  // callback stays a pure, total function of `raw` plus these constants.
  const fingerprint = providerContentFingerprint(input.fields);
  const { fetchedSnapshotAtMs, playerId, page, ingestionRunId, providerSetId, fields } = input;

  let outcome: UpsertSourceSetOutcome = 'created';
  let previousProjectedMatchKeys: string[] = [];
  let previousClassification: ResearchSetClassification | null = null;
  let previousIngestionRunId: string | null = null;
  let previousIngestionPage: number | null = null;
  let previousFingerprint: string | null = null;
  let baselineFingerprint: string | null = null;
  let contributes = true;
  let uniqueToTenant = true;
  let resolvedFirstIngestionPlayerId: string | null = playerId;

  const ref = database.ref(`researchSource/${input.tenantId}/sets/${storageKey}`);

  try {
    await ref.transaction((raw) => {
      // Reset per invocation (review CR-01) — a value captured during a
      // DISCARDED (null-first-run or hash-mismatch) invocation must never
      // leak into the final outcome; only the invocation whose return value
      // actually commits may report success.
      previousProjectedMatchKeys = [];
      previousClassification = null;
      previousIngestionRunId = null;
      previousIngestionPage = null;
      previousFingerprint = null;
      baselineFingerprint = null;
      contributes = true;
      uniqueToTenant = true;
      resolvedFirstIngestionPlayerId = playerId;
      outcome = 'created';

      const prior = parseSourceRecord(raw);

      if (!prior) {
        return buildStoredSourceSet({
          providerSetId,
          storageKey,
          keyDerived,
          fields,
          fingerprint,
          baselineFingerprint: null,
          ingestionRunId,
          ingestionPage: page,
          firstIngestionPlayerId: playerId,
          fetchedAtMs: fetchedSnapshotAtMs,
          lastObservedAtMs: fetchedSnapshotAtMs,
          projectedMatchKeys: [],
        });
      }

      previousProjectedMatchKeys = prior.projectedMatchKeys ?? [];
      previousClassification = prior.classification;
      previousIngestionRunId = prior.ingestionRunId;
      previousIngestionPage = prior.ingestionPage ?? null;
      previousFingerprint = prior.contentFingerprint ?? null;
      resolvedFirstIngestionPlayerId = prior.firstIngestionPlayerId ?? playerId;

      // STALE-WRITE COMPARE-AND-SKIP (review C3-H5): the stored record was
      // written from a NEWER observation of this set than the one this call
      // is holding, so applying this write would REGRESS it. Scenario: a
      // holder's lease expires mid-page while it is stalled, a second holder
      // takes over and writes this set with corrected provider content, the
      // first holder wakes and writes the content of ITS OWN older fetch.
      // Strictly-greater keeps two writes derived from ONE page attempt
      // (equal snapshots) order-independent — the ordinary path is
      // untouched. This is an ordering fact about two observations, never a
      // fact about the set: it never throws and never reports a
      // data-quality classification.
      if (prior.lastObservedAtMs > fetchedSnapshotAtMs) {
        outcome = 'stale-write-skipped';
        contributes = false;
        uniqueToTenant = false;
        baselineFingerprint = prior.baselineFingerprint ?? null;
        return raw;
      }

      // BASELINE RESOLUTION (review C2-H2): carried forward unchanged while
      // the SAME run keeps retrying the SAME page (so the baseline keeps
      // describing the state before that page's FIRST attempt); reset to
      // the prior stored fingerprint whenever a new run or a new page
      // observes the record. Without the carry-forward, a correction
      // applied on an abandoned page attempt re-upserts as
      // `replaced-unchanged` on the retry and its `corrected` increment is
      // lost forever.
      const samePageRetry =
        prior.ingestionRunId === ingestionRunId && (prior.ingestionPage ?? null) === page;
      baselineFingerprint = samePageRetry
        ? (prior.baselineFingerprint ?? null)
        : (prior.contentFingerprint ?? null);

      // PAGE MARKER AND OWNER RESOLUTION (review C3-H4a): the contribution
      // verdict is computed HERE, inside the callback, from the parsed
      // prior — so exactly one definition of it exists in the codebase.
      // `ingestionPage` moves ONLY on a contributing write; carrying the
      // prior value forward otherwise prevents a non-contributing
      // re-observation (a set already committed on an earlier page) from
      // making a RETRY of the later page see its own page number, judge
      // itself contributing, and count the set a second time.
      contributes =
        prior.ingestionRunId !== ingestionRunId || (prior.ingestionPage ?? null) === page;
      const nextIngestionPage = contributes ? page : (prior.ingestionPage ?? page);

      // `firstIngestionPlayerId` is written once and never changed; an
      // absent prior value means the record predates the member and is
      // CLAIMED by this run (review C3-A5).
      uniqueToTenant = resolvedFirstIngestionPlayerId === playerId;

      outcome = fingerprint === previousFingerprint ? 'replaced-unchanged' : 'replaced-changed';

      return buildStoredSourceSet({
        providerSetId,
        storageKey,
        keyDerived,
        fields,
        fingerprint,
        baselineFingerprint,
        ingestionRunId,
        ingestionPage: nextIngestionPage,
        firstIngestionPlayerId: resolvedFirstIngestionPlayerId,
        fetchedAtMs: prior.fetchedAtMs,
        lastObservedAtMs: fetchedSnapshotAtMs,
        projectedMatchKeys: previousProjectedMatchKeys,
      });
    });
  } catch (cause) {
    throw new ResearchIngestionWriteError(
      'Failed to write research source set',
      `researchSource/${input.tenantId}/sets/${storageKey}`,
      cause,
    );
  }

  return {
    outcome,
    storageKey,
    keyDerived,
    contributes,
    uniqueToTenant,
    firstIngestionPlayerId: resolvedFirstIngestionPlayerId,
    previousProjectedMatchKeys,
    previousClassification,
    previousIngestionRunId,
    previousIngestionPage,
    previousFingerprint,
    baselineFingerprint,
    fingerprint,
  };
}

/**
 * Callers pass the value `upsertResearchSourceSet` returned as `storageKey`
 * — the raw provider id in every ordinary case, a derived digest when the
 * raw id was not a legal RTDB key (review C2-A7). Guarded with
 * `isPathSafeProviderId` and returns null rather than throwing for an
 * unsafe value, so no caller can construct a reference from a raw id by
 * mistake.
 */
export async function readResearchSourceSet(
  database: Database,
  tenantId: string,
  storageKey: string,
): Promise<ResearchSourceSetRecord | null> {
  if (!isPathSafeProviderId(storageKey)) {
    return null;
  }
  const snapshot = await database.ref(`researchSource/${tenantId}/sets/${storageKey}`).get();
  if (!snapshot.exists()) {
    return null;
  }
  const parsed = researchSourceSetRecordSchema.safeParse(snapshot.val());
  return parsed.success ? parsed.data : null;
}
