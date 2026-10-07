import {
  ACTION_SLOT_KEYS,
  buildActionCandidates,
  MAX_RECOMMENDED_ACTIONS,
  rankActionCandidates,
  type ActionCandidate,
  type ClaimAtom,
  type ClaimAtomRecord,
  type ClaimId,
  type StoredScoutReport,
} from '@smash-tracker/shared';

/**
 * Phase 39 (plan 39-11, RPT-09 / D-12): the PAID outputs' recommended actions,
 * read back from a stored report or practice plan.
 *
 * A stored record keeps the model's choice as up to three keyed slots
 * (`action1`..`action3`), each `{ actionId, claimId }` — the candidate itself
 * (kind, axes, title key) is not persisted, and the `actionId` only has
 * meaning against the ranked list that existed at generation time. So the
 * slot is resolved through its CLAIM, which is stored: the stored claims run
 * back through the SAME shared engine (`buildActionCandidates` →
 * `rankActionCandidates`), and each slot takes the highest-ranked candidate
 * citing its claim. The engine's VOD references are not persisted either, so
 * a slot whose claim licenses only a `vod_review` has no candidate here and is
 * not drawn — never a guessed door.
 *
 * Pure: no React, no route, no uid.
 */

type StoredClaimMap = NonNullable<StoredScoutReport['claims']>;
type StoredActionSlots = NonNullable<StoredScoutReport['actions']>;

/** A stored claim (RTDB-stripped nullish members) back in the engine's in-memory `ClaimAtom` shape. */
export function toClaimAtom(record: ClaimAtomRecord): ClaimAtom {
  return {
    id: record.id as ClaimId,
    predicate: record.predicate,
    subject: {
      myFighterId: record.subject?.myFighterId ?? null,
      opponentFighterId: record.subject?.opponentFighterId ?? null,
      stageId: record.subject?.stageId ?? null,
      opponentTag: record.subject?.opponentTag ?? null,
    },
    value: record.value,
    claimKind: record.claimKind,
    evidenceIds: record.evidenceIds,
    tier: record.tier ?? null,
    policyVersion: record.policyVersion,
    sample: {
      ...record.sample,
      dateRange: record.sample.dateRange ?? null,
      confidenceTier: record.sample.confidenceTier ?? null,
    },
  };
}

export interface ResolvedStoredActions {
  claims: readonly ClaimAtom[];
  actions: readonly ActionCandidate[];
}

/** Resolves a stored record's action slots, in slot order, to at most `MAX_RECOMMENDED_ACTIONS` candidates. */
export function resolveStoredActions(input: {
  actions: StoredActionSlots | null | undefined;
  claims: StoredClaimMap | null | undefined;
}): ResolvedStoredActions {
  const claims = Object.values(input.claims ?? {}).map(toClaimAtom);
  const slots = input.actions ?? {};
  const ranked = rankActionCandidates(buildActionCandidates({ claims, vodRefs: [] }));

  const chosen: ActionCandidate[] = [];
  for (const slotKey of ACTION_SLOT_KEYS) {
    const claimId = slots[slotKey]?.claimId;
    if (!claimId) {
      continue;
    }
    const candidate = ranked.find(
      (entry) =>
        entry.claimIds.includes(claimId as ClaimId) &&
        !chosen.some((picked) => picked.id === entry.id),
    );
    if (candidate) {
      chosen.push(candidate);
    }
  }
  return { claims, actions: chosen.slice(0, MAX_RECOMMENDED_ACTIONS) };
}
