import type { Database } from 'firebase-admin/database';
import {
  isPathSafeProviderId,
  researchIdentityMappingSchema,
  type ResearchIdentityCandidate,
  type ResearchIdentityConfirmedPlayer,
  type ResearchIdentityMapping,
} from '@smash-tracker/shared';
import {
  resolvePlayerById,
  resolvePlayerBySlug,
  type StartggResearchSet,
} from '../../startgg/client.js';

/**
 * Phase 30 Plan 04 (ING-07): the admin-confirmed, multi-player-ID identity
 * mapping that gates every backfill, plus non-authoritative candidate
 * discovery.
 *
 * This module performs NO authorization of its own — the module contract
 * copied verbatim in spirit from `apps/api/src/research/tenants.ts`:
 * `requireResearchTenantAdmin` in `apps/api/src/routes/research.ts` is the
 * single authorization site for this whole route family. Adding a second
 * check here would create two places to keep in sync, and only one of them
 * would ever be exercised by a given call path.
 *
 * This module enforces exactly ONE domain invariant: `confirmIdentityPlayers`
 * is the ONLY function in the codebase that writes `confirmedPlayerIds`, and
 * no other function may promote a candidate (D-10, D-11). It emits NOTHING
 * and imports no event machinery.
 *
 * `knownTagVariants` and `sponsorPrefixes` are stored as ING-07 EVIDENCE and
 * as mining hints ONLY — this module matches on player IDs, never on name
 * strings (D-13). Normalized tag comparison exists solely to compare a
 * candidate's observed gamertag against a confirmed player's known variants;
 * it is never written back over a stored verbatim name.
 *
 * Provider limitation this design exists around: start.gg's public schema
 * has no name/gamertag search at the root query level, so there is no "find
 * this player" call to make (`30-RESEARCH.md` Assumption A3). Candidates are
 * seeded by an admin supplying a profile slug or numeric id
 * (`resolveSeedIdentity`), plus mined from entrant records already in the
 * source tier (`mineIdentityCandidates`). Plan 30-08 documents this in the
 * coverage audit as a permanent provider limitation, not a shortfall of the
 * implementation.
 */

function identityRef(database: Database, tenantId: string) {
  return database.ref(`researchIdentity/${tenantId}`);
}

/**
 * A malformed/unparseable node degrades to an empty mapping rather than
 * throwing inside a transaction callback (CR-01 discipline, mirrors
 * `apps/api/src/research/entitlements.ts`'s `parseRecord`).
 */
function parseMapping(raw: unknown): ResearchIdentityMapping {
  const parsed = researchIdentityMappingSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : {};
}

/**
 * Conditional-spread stored-shape builder (house constraint 1): a member
 * that is null/absent/empty is OMITTED entirely, never written as a bare
 * `null` — a `.transaction()` return replaces the WHOLE node, so omission is
 * exactly deletion.
 */
function buildStoredMapping(mapping: ResearchIdentityMapping): Record<string, unknown> {
  const hasConfirmed =
    mapping.confirmedPlayerIds != null && Object.keys(mapping.confirmedPlayerIds).length > 0;
  const hasCandidates = mapping.candidates != null && Object.keys(mapping.candidates).length > 0;
  return {
    ...(hasConfirmed ? { confirmedPlayerIds: mapping.confirmedPlayerIds } : {}),
    ...(hasCandidates ? { candidates: mapping.candidates } : {}),
    ...(mapping.lastConfirmedByUid != null
      ? { lastConfirmedByUid: mapping.lastConfirmedByUid }
      : {}),
    ...(mapping.lastConfirmedAtMs != null ? { lastConfirmedAtMs: mapping.lastConfirmedAtMs } : {}),
  };
}

/** Reads the whole mapping. An absent record returns an empty mapping — no confirmed players, no candidates. */
export async function readIdentityMapping(
  database: Database,
  tenantId: string,
): Promise<ResearchIdentityMapping> {
  const snapshot = await identityRef(database, tenantId).get();
  return parseMapping(snapshot.val());
}

/**
 * The fail-closed default: an empty mapping yields an empty set, so a
 * classifier fed by it classifies every set as unresolved rather than
 * silently backfilling before any confirmation exists.
 */
export function confirmedPlayerIdSet(mapping: ResearchIdentityMapping): ReadonlySet<string> {
  return new Set(Object.keys(mapping.confirmedPlayerIds ?? {}));
}

/**
 * Normalizes each stored `gamerTag` and each `knownTagVariants` member the
 * same way candidate mining does: split on the sponsor separator (`|`)
 * taking the trailing segment, trim, lowercase — mirrors
 * `apps/api/src/startgg/sync.ts`'s `normalizeOpponentTag` without its
 * RTDB-illegal-character strip (this normalized form is never written back
 * to storage, only compared in memory).
 *
 * This normalization exists ONLY to compare a candidate's observed gamertag
 * against a confirmed player's known variants (D-13) — it is never an
 * authoritative identity key.
 */
function normalizeTagForMining(tag: string): string {
  const trailing = tag.includes('|') ? (tag.split('|').pop() ?? tag) : tag;
  return trailing.trim().toLowerCase();
}

export function confirmedTagVariants(mapping: ResearchIdentityMapping): ReadonlySet<string> {
  const variants = new Set<string>();
  for (const entry of Object.values(mapping.confirmedPlayerIds ?? {})) {
    if (entry.gamerTag) {
      variants.add(normalizeTagForMining(entry.gamerTag));
    }
    for (const variant of entry.knownTagVariants ?? []) {
      variants.add(normalizeTagForMining(variant));
    }
  }
  return variants;
}

/**
 * The ONLY sanctioned way any caller resolves "the primary confirmed player
 * id" (review C-M4). Returns the flagged id when exactly one exists;
 * otherwise falls back to the LEXICOGRAPHICALLY SMALLEST confirmed player
 * id, returning null only for a mapping with no confirmed players at all.
 *
 * The fallback is deterministic rather than "the first one" on purpose:
 * RTDB record iteration order is not a contract, and 30-07's trigger route
 * must pick the SAME player on every invocation, or a retried trigger could
 * backfill a different person than an earlier attempt did.
 */
export function selectPrimaryConfirmedPlayerId(mapping: ResearchIdentityMapping): string | null {
  const entries = Object.entries(mapping.confirmedPlayerIds ?? {});
  if (entries.length === 0) {
    return null;
  }
  const flagged = entries.find(([, entry]) => entry.primary === true);
  if (flagged) {
    return flagged[0];
  }
  return entries.map(([playerId]) => playerId).sort()[0]!;
}

export interface ConfirmIdentityPlayerInput {
  playerId: string;
  gamerTag?: string;
  userSlug?: string;
  knownTagVariants?: string[];
  sponsorPrefixes?: string[];
  primary?: boolean;
}

export interface ConfirmIdentityResult {
  confirmedPlayerIds: string[];
  rejectedPlayerIds: string[];
}

/**
 * The ONLY function in the codebase that may write `confirmedPlayerIds`
 * (D-10, D-11, T-30-04-01). Confirming an id that already exists as a
 * candidate promotes it — the id lands under `confirmedPlayerIds` and is
 * removed from `candidates` in the SAME transaction. Confirming an
 * already-confirmed id is a no-op for that id: the original `confirmedAtMs`
 * is preserved verbatim. An RTDB-illegal player id is rejected (reported in
 * `rejectedPlayerIds`), never thrown, never written — the remaining valid
 * ids in the same call still confirm.
 *
 * Single-primary enforcement (review C-M4) lives in this SAME transaction:
 * after applying every valid input, if any input asked for `primary: true`,
 * the LAST such input (in array order) wins and every OTHER confirmed
 * record has its `primary` member omitted from the rebuilt object. Because
 * the whole mapping is one node and the rebuild is a conditional spread,
 * omission is deletion — there is no second write and no window in which
 * two records claim primacy. This is a deliberate design choice: object /
 * array iteration order is not a contract to rely on, so "last input wins"
 * is documented and tested rather than left to iteration order to decide.
 */
export async function confirmIdentityPlayers(
  database: Database,
  tenantId: string,
  adminUid: string,
  players: ConfirmIdentityPlayerInput[],
  now: number = Date.now(),
): Promise<ConfirmIdentityResult> {
  const rejectedPlayerIds: string[] = [];
  const validInputs = players.filter((player) => {
    if (!isPathSafeProviderId(player.playerId)) {
      rejectedPlayerIds.push(player.playerId);
      return false;
    }
    return true;
  });

  if (validInputs.length === 0) {
    // Nothing valid to confirm — leave the record unchanged, still report
    // any rejections.
    return { confirmedPlayerIds: [], rejectedPlayerIds };
  }

  // The id of the LAST input in this call that asked for `primary: true` —
  // pre-computed outside the transaction callback (CR-01: the callback must
  // be a pure, repeatable function of `raw` plus pre-generated constants).
  let lastPrimaryRequestId: string | null = null;
  for (const input of validInputs) {
    if (input.primary === true) {
      lastPrimaryRequestId = input.playerId;
    }
  }

  const result = await identityRef(database, tenantId).transaction((raw) => {
    const current = parseMapping(raw);
    const nextConfirmed: Record<string, ResearchIdentityConfirmedPlayer> = {
      ...(current.confirmedPlayerIds ?? {}),
    };
    const nextCandidates: Record<string, ResearchIdentityCandidate> = {
      ...(current.candidates ?? {}),
    };

    for (const input of validInputs) {
      const existing = nextConfirmed[input.playerId];
      if (existing) {
        // Already confirmed — no-op for this id, preserve the original
        // confirmation verbatim (including its `confirmedAtMs`).
        continue;
      }
      nextConfirmed[input.playerId] = {
        playerId: input.playerId,
        confirmedByUid: adminUid,
        confirmedAtMs: now,
        ...(input.gamerTag != null ? { gamerTag: input.gamerTag } : {}),
        ...(input.userSlug != null ? { userSlug: input.userSlug } : {}),
        ...(input.knownTagVariants != null ? { knownTagVariants: input.knownTagVariants } : {}),
        ...(input.sponsorPrefixes != null ? { sponsorPrefixes: input.sponsorPrefixes } : {}),
      };
      // A confirmed id is removed from candidates in the SAME transaction —
      // no function other than this one may promote a candidate.
      delete nextCandidates[input.playerId];
    }

    // Single-primary enforcement: the last-input-wins id keeps `primary`;
    // every OTHER confirmed record has the member omitted on rebuild.
    for (const [playerId, entry] of Object.entries(nextConfirmed)) {
      const shouldBePrimary =
        lastPrimaryRequestId != null && playerId === lastPrimaryRequestId
          ? true
          : entry.primary === true && lastPrimaryRequestId == null;
      nextConfirmed[playerId] = {
        ...entry,
        ...(shouldBePrimary ? { primary: true } : {}),
      };
      if (!shouldBePrimary) {
        delete nextConfirmed[playerId]!.primary;
      }
    }

    return buildStoredMapping({
      confirmedPlayerIds: nextConfirmed,
      candidates: nextCandidates,
      lastConfirmedByUid: adminUid,
      lastConfirmedAtMs: now,
    });
  });

  // Derive the response from the COMMITTED snapshot, never from local
  // intent — mirrors `apps/api/src/research/entitlements.ts`'s discipline.
  const committed = parseMapping(result.snapshot.val());
  const confirmedIds = validInputs
    .map((input) => input.playerId)
    .filter((playerId) => committed.confirmedPlayerIds?.[playerId] != null);

  return { confirmedPlayerIds: confirmedIds, rejectedPlayerIds };
}

/** Removes one confirmed id, leaving the others and all candidates intact. */
export async function revokeConfirmedPlayer(
  database: Database,
  tenantId: string,
  playerId: string,
): Promise<{ ok: true }> {
  if (!isPathSafeProviderId(playerId)) {
    return { ok: true };
  }

  await identityRef(database, tenantId).transaction((raw) => {
    const current = parseMapping(raw);
    if (!current.confirmedPlayerIds?.[playerId]) {
      return buildStoredMapping(current);
    }
    const nextConfirmed = { ...current.confirmedPlayerIds };
    delete nextConfirmed[playerId];
    return buildStoredMapping({
      confirmedPlayerIds: nextConfirmed,
      candidates: current.candidates,
      lastConfirmedByUid: current.lastConfirmedByUid,
      lastConfirmedAtMs: current.lastConfirmedAtMs,
    });
  });

  return { ok: true };
}

export interface IdentityCandidateInput {
  playerId: string;
  gamerTag?: string;
  userSlug?: string;
  observedEntrantName?: string;
  observedInSetId?: string;
}

export interface RecordCandidatesResult {
  added: number;
  updated: number;
  skippedConfirmed: number;
  rejected: number;
}

/**
 * Records non-authoritative candidates. A candidate for a player id that is
 * already CONFIRMED writes nothing — a confirmed id is never re-proposed as
 * a candidate. A brand-new candidate is written with `firstObservedAtMs`
 * equal to `lastObservedAtMs` and `observationCount: 1`; an already-recorded
 * candidate preserves its `firstObservedAtMs`, advances `lastObservedAtMs`,
 * and increments `observationCount`. No function in this module ever moves
 * an id from `candidates` to `confirmedPlayerIds` except
 * `confirmIdentityPlayers`.
 */
export async function recordIdentityCandidates(
  database: Database,
  tenantId: string,
  candidates: IdentityCandidateInput[],
  now: number,
): Promise<RecordCandidatesResult> {
  const result: RecordCandidatesResult = { added: 0, updated: 0, skippedConfirmed: 0, rejected: 0 };

  const validCandidates = candidates.filter((candidate) => {
    if (!isPathSafeProviderId(candidate.playerId)) {
      result.rejected += 1;
      return false;
    }
    return true;
  });

  if (validCandidates.length === 0) {
    return result;
  }

  await identityRef(database, tenantId).transaction((raw) => {
    const current = parseMapping(raw);
    const nextCandidates: Record<string, ResearchIdentityCandidate> = {
      ...(current.candidates ?? {}),
    };
    const confirmed = current.confirmedPlayerIds ?? {};

    // Reset per-invocation counters on every callback run (CR-01: the
    // callback can run more than once and must be a pure function of its
    // input — counters computed here reflect only THIS run's tally).
    let added = 0;
    let updated = 0;
    let skippedConfirmed = 0;

    for (const candidate of validCandidates) {
      if (confirmed[candidate.playerId]) {
        skippedConfirmed += 1;
        continue;
      }
      const existing = nextCandidates[candidate.playerId];
      if (existing) {
        nextCandidates[candidate.playerId] = {
          ...existing,
          lastObservedAtMs: now,
          observationCount: (existing.observationCount ?? 1) + 1,
          ...(candidate.gamerTag != null ? { gamerTag: candidate.gamerTag } : {}),
          ...(candidate.userSlug != null ? { userSlug: candidate.userSlug } : {}),
          ...(candidate.observedEntrantName != null
            ? { observedEntrantName: candidate.observedEntrantName }
            : {}),
          ...(candidate.observedInSetId != null
            ? { observedInSetId: candidate.observedInSetId }
            : {}),
        };
        updated += 1;
      } else {
        nextCandidates[candidate.playerId] = {
          playerId: candidate.playerId,
          firstObservedAtMs: now,
          lastObservedAtMs: now,
          observationCount: 1,
          ...(candidate.gamerTag != null ? { gamerTag: candidate.gamerTag } : {}),
          ...(candidate.userSlug != null ? { userSlug: candidate.userSlug } : {}),
          ...(candidate.observedEntrantName != null
            ? { observedEntrantName: candidate.observedEntrantName }
            : {}),
          ...(candidate.observedInSetId != null
            ? { observedInSetId: candidate.observedInSetId }
            : {}),
        };
        added += 1;
      }
    }

    result.added = added;
    result.updated = updated;
    result.skippedConfirmed = skippedConfirmed;

    return buildStoredMapping({
      confirmedPlayerIds: current.confirmedPlayerIds,
      candidates: nextCandidates,
      lastConfirmedByUid: current.lastConfirmedByUid,
      lastConfirmedAtMs: current.lastConfirmedAtMs,
    });
  });

  return result;
}

/**
 * A PURE function over one page of sets — it NEVER reads the database. This
 * is what keeps candidate discovery bounded and satisfies D-15's
 * no-full-scan rule: the batch executor calls this per page with the sets
 * it already has in hand, rather than any post-hoc scan of `researchSource`.
 *
 * For each set, for each entrant, for each participant: emits a candidate
 * when the participant's player id is present, is NOT already confirmed,
 * and the participant's normalized gamertag is in
 * `confirmedTagVariants(mapping)`. De-duplicates by player id within the
 * returned list. Returns an empty list when the mapping has no tag
 * variants at all — there is nothing to mine against.
 */
export function mineIdentityCandidates(
  sets: StartggResearchSet[],
  mapping: ResearchIdentityMapping,
): IdentityCandidateInput[] {
  const variants = confirmedTagVariants(mapping);
  if (variants.size === 0) {
    return [];
  }
  const confirmed = new Set(Object.keys(mapping.confirmedPlayerIds ?? {}));
  const seen = new Set<string>();
  const results: IdentityCandidateInput[] = [];

  for (const set of sets) {
    for (const slot of set.slots ?? []) {
      const entrant = slot?.entrant;
      if (!entrant) {
        continue;
      }
      for (const participant of entrant.participants ?? []) {
        const player = participant?.player;
        if (!player) {
          continue;
        }
        const playerId = String(player.id);
        if (confirmed.has(playerId) || seen.has(playerId)) {
          continue;
        }
        const gamerTag = player.gamerTag ?? undefined;
        if (!gamerTag || !variants.has(normalizeTagForMining(gamerTag))) {
          continue;
        }
        seen.add(playerId);
        results.push({
          playerId,
          gamerTag,
          observedEntrantName: entrant.name ?? undefined,
          observedInSetId: String(set.id),
        });
      }
    }
  }

  return results;
}

/**
 * Resolves a proposed seed identity WITHOUT writing anything —
 * `resolvePlayerBySlug`/`resolvePlayerById` propose, `confirmIdentityPlayers`
 * confirms; these are deliberately separate calls (D-10). Delegates to the
 * existing `apps/api/src/startgg/client.ts` resolvers rather than
 * reimplementing them, coercing the returned numeric player id to a string.
 * Returns null when neither `slug` nor `playerId` resolves.
 */
export async function resolveSeedIdentity(
  serverToken: string,
  input: { slug?: string; playerId?: number },
  fetchImpl: typeof fetch = fetch,
): Promise<{ playerId: string; gamerTag?: string; userSlug?: string } | null> {
  if (input.slug != null) {
    const resolved = await resolvePlayerBySlug(serverToken, input.slug, fetchImpl);
    if (!resolved) {
      return null;
    }
    return {
      playerId: String(resolved.id),
      gamerTag: resolved.gamerTag,
      userSlug: resolved.userSlug,
    };
  }
  if (input.playerId != null) {
    const resolved = await resolvePlayerById(serverToken, input.playerId, fetchImpl);
    if (!resolved) {
      return null;
    }
    return {
      playerId: String(resolved.id),
      gamerTag: resolved.gamerTag,
      ...(resolved.userSlug != null ? { userSlug: resolved.userSlug } : {}),
    };
  }
  return null;
}
