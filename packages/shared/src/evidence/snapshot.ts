/**
 * RPT-08 / D-05 (phase 39 plan 01, wave 1): the immutable snapshot's TYPES,
 * ID CONSTRUCTION and REGEX VALIDATION only.
 *
 * This module MUST NOT import `node:crypto` or any other `node:` specifier,
 * and MUST NOT contain a canonicalizer or a digest (review C1-B2). It is
 * reachable from the browser bundle through `packages/shared/src/index.ts`
 * (the package's `exports` map has only `.` and `./testUtils`), and
 * `researchEnrichment.ts`'s shipped doc comment states this same rule for
 * this same reason: a `node:` import here would break every one of the
 * web's 440+ call sites that import the root barrel. Hashing lives in
 * `apps/api/src/reports/snapshotId.ts` (plan 39-06), which reuses the
 * EXISTING `canonicalJson`/`canonicalDigest` from
 * `apps/api/src/research/registry/canonical.ts` — reused, never ported.
 * There is no second canonicalizer anywhere in this repo, so the drift
 * class this phase would otherwise open does not exist to cross-check.
 *
 * Evidence ids are SYNTHETIC and free text is NEVER a key: every builder
 * below is a pure string concatenation over closed, small, already-typed
 * axes (a fighter id, a stage id, an opponent tag's INDEX in a snapshot-
 * scoped ordering) — never a hash, and never the free text itself. An
 * opponent tag rides in `ClaimSubject.opponentTag` as a VALUE, never as a
 * key. This is what removes the untrusted-text-to-RTDB-key path outright,
 * instead of hashing it, and it is why this module needs no crypto.
 */
import type { ClaimPredicate, ClaimSubject, ClaimValue } from './claims.js';
import { isRtdbSafeKeySegment } from './claims.js';
import type { CohortComposition } from './cohort.js';
import type { SampleMeta } from './types.js';

/** One row of an `EvidenceSnapshot` — the record a claim's value is recomputed against. */
export interface EvidenceRow {
  predicate: ClaimPredicate;
  subject: ClaimSubject;
  value: ClaimValue;
  sample: SampleMeta;
}

/**
 * The engine's evidence ROWS (not raw matches — size is bounded by the
 * number of (predicate, subject) rows, never by history length) plus
 * cohort, policy version and a digest of the input match IDs. Content-
 * addressed at `evidenceSnapshots/{uid}/{snapshotId}` (plan 39-06).
 *
 * `rows` is a KEYED MAP, never an array: RTDB strips nulls INSIDE arrays,
 * so a positional array of nullable rows reads back sparse/short and fails
 * its own schema (the house conditional-spread rule covers object members
 * only, not array elements). `matchIdDigest.hash` is a value the API
 * COMPUTES and hands in — this module never produces it.
 */
export interface EvidenceSnapshot {
  policyVersion: number;
  claimSchemaVersion: number;
  refreshedAt: number;
  cohort: CohortComposition;
  rows: Readonly<Record<string, EvidenceRow>>;
  matchIdDigest: { count: number; hash: string };
}

/** The shape assertion the API's `snapshotIdFor` output (plan 39-06) must satisfy — 64 lowercase hex characters (a sha256 digest). */
export const SNAPSHOT_ID_LENGTH = 64;

const SNAPSHOT_ID_PATTERN = new RegExp(`^[0-9a-f]{${SNAPSHOT_ID_LENGTH}}$`);

/** True when `value` has the shape a content-addressed snapshot id must have. Construction of that id is plan 39-06's, in `apps/api`. */
export function isSnapshotId(value: string): boolean {
  return SNAPSHOT_ID_PATTERN.test(value);
}

/**
 * The snapshot fields the API's hash input MUST exclude when it computes
 * `snapshotIdFor` (plan 39-06) — at minimum `refreshedAt`, which is
 * wall-clock and would otherwise make two jobs over IDENTICAL evidence
 * content-address differently. Exporting the list here, where the type
 * lives, is what keeps the API's hash input and this type in lockstep.
 */
export const SNAPSHOT_HASH_EXCLUDED_FIELDS: readonly string[] = ['refreshedAt'];

/**
 * A CLOSED table, total over all ten members of `CLAIM_PREDICATES`. Values
 * are pairwise distinct, lowercase, contain no `-` (so splitting an id on
 * its FIRST `-` recovers the prefix unambiguously), and match
 * `/^[a-z0-9]{2,4}$/`.
 */
export const EVIDENCE_ID_PREFIX: Readonly<Record<ClaimPredicate, string>> = {
  stage_record: 'sr',
  stage_pick_rate: 'spr',
  character_matchup_record: 'cmr',
  my_character_record: 'mcr',
  head_to_head_record: 'h2h',
  recent_form: 'rf',
  opponent_character_usage: 'ocu',
  matchup_advisor_pick: 'map',
  vod_annotation: 'vod',
  cohort_disclosure: 'cd',
};

/**
 * Thrown by `evidenceIdFor` for the one predicate it does not serve
 * (`vod_annotation`, whose subject axis is a `(matchId, seconds)` pair, not
 * a member of `ClaimSubject`) and for an `opponentTag` absent from the
 * caller-supplied `opponentOrder` — a caller bug in both cases, never
 * silently returning `null` or indexing `-1`.
 */
export class UnsupportedEvidenceSubjectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedEvidenceSubjectError';
  }
}

/**
 * The ONE exported opponent ordering (review C2-M10): de-duplicate, then
 * sort ascending by raw UTF-16 code-unit comparison (`a < b`) — NEVER
 * `localeCompare`, whose collation is locale-dependent and would order
 * differently under the API's Node ICU and a browser's. `evidenceIdFor`
 * looks an opponent tag up in this ordering rather than accepting a bare
 * index, so the API host and the web producer (plan 39-11) cannot
 * independently derive two different orderings. An opponent id built from
 * this ordering is stable only WITHIN the snapshot it was built for — the
 * only scope in which an evidence id has meaning, since the snapshot is
 * immutable and content-addressed.
 */
export function orderSnapshotOpponents(tags: readonly string[]): readonly string[] {
  const deduped = Array.from(new Set(tags));
  return deduped.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Throws `UnsupportedEvidenceSubjectError` if `id` is not a safe RTDB key segment — a defensive invariant over this module's own construction, never expected to fire on a correctly-built id. */
function assertRtdbSafeKey(id: string): string {
  if (!isRtdbSafeKeySegment(id)) {
    throw new UnsupportedEvidenceSubjectError(
      `evidence id "${id}" is not a safe RTDB key segment (does not satisfy EVIDENCE_ID_PATTERN)`,
    );
  }
  return id;
}

/**
 * `rows` is one row per (predicate, subject) — an id keyed on the subject
 * alone would make `stage_record` and `stage_pick_rate` over the same stage
 * collide on one map key (silently losing a row), and would leave
 * `recent_form`/`cohort_disclosure` — both legitimately axis-free — with no
 * id at all (review C2-B2). This is the ONE total function every predicate
 * except `vod_annotation` routes its id through.
 *
 * `<EVIDENCE_ID_PREFIX[predicate]>-<subjectKey>`, where `subjectKey`
 * concatenates, with `-`, the NON-NULL axes of `subject` in a FIXED order,
 * each carrying its own marker letter: `myFighterId` -> `f<id>`,
 * `opponentFighterId` -> `g<id>`, `stageId` -> `s<id>`, `opponentTag` ->
 * `o<index>` where `index` is the tag's position in `opponentOrder`. When
 * EVERY axis is null the subject key is the literal `all` — that is how
 * `recent_form` (`rf-all`) and `cohort_disclosure` (`cd-all`) get ids at
 * all, and why they are one row each per snapshot rather than none.
 */
export function evidenceIdFor(input: {
  predicate: ClaimPredicate;
  subject: ClaimSubject;
  opponentOrder: readonly string[];
}): string {
  const { predicate, subject, opponentOrder } = input;

  // vod_annotation is the one predicate this function does not serve — its
  // subject axis is the (matchId, seconds) pair, which is not a member of
  // ClaimSubject. Use vodEvidenceId(matchId, seconds) for that predicate.
  if (predicate === 'vod_annotation') {
    throw new UnsupportedEvidenceSubjectError(
      "evidenceIdFor does not serve 'vod_annotation': its subject axis is the (matchId, seconds) pair, not a member of ClaimSubject. Use vodEvidenceId(matchId, seconds) instead.",
    );
  }

  const segments: string[] = [];
  if (subject.myFighterId !== null) {
    segments.push(`f${subject.myFighterId}`);
  }
  if (subject.opponentFighterId !== null) {
    segments.push(`g${subject.opponentFighterId}`);
  }
  if (subject.stageId !== null) {
    segments.push(`s${subject.stageId}`);
  }
  if (subject.opponentTag !== null) {
    const index = opponentOrder.indexOf(subject.opponentTag);
    if (index === -1) {
      throw new UnsupportedEvidenceSubjectError(
        `evidenceIdFor: opponentTag "${subject.opponentTag}" is absent from the supplied opponentOrder`,
      );
    }
    segments.push(`o${index}`);
  }

  const subjectKey = segments.length > 0 ? segments.join('-') : 'all';
  return assertRtdbSafeKey(`${EVIDENCE_ID_PREFIX[predicate]}-${subjectKey}`);
}

/**
 * The `vod_annotation` bijection (C1-M8), living INSIDE the same
 * `EVIDENCE_ID_PREFIX` namespace as every other predicate (`vod-` IS
 * `EVIDENCE_ID_PREFIX.vod_annotation` plus the separator). This pair IS the
 * shipped `allowedPairs` identity `${matchId}:${seconds}`
 * (`apps/api/src/reports/synthesis.ts`) re-expressed in an
 * `EVIDENCE_ID_PATTERN`-safe form: `:` is legal in an RTDB key but this
 * phase's own pattern rejects it. Plan 39-08's set-equality criterion is
 * written through this function and `parseVodEvidenceId` below.
 */
export function vodEvidenceId(matchId: string, seconds: number): string {
  return assertRtdbSafeKey(`${EVIDENCE_ID_PREFIX.vod_annotation}-${matchId}-${seconds}`);
}

/**
 * Parses a `vodEvidenceId` output back into its `(matchId, seconds)` pair,
 * or `null` for anything outside that grammar. Strips the `vod-` prefix and
 * splits on the LAST `-`, so a `matchId` containing `-` (an RTDB push key
 * does) still round-trips.
 */
export function parseVodEvidenceId(id: string): { matchId: string; seconds: number } | null {
  const prefix = `${EVIDENCE_ID_PREFIX.vod_annotation}-`;
  if (!id.startsWith(prefix)) {
    return null;
  }
  const rest = id.slice(prefix.length);
  const lastDash = rest.lastIndexOf('-');
  if (lastDash === -1) {
    return null;
  }
  const matchId = rest.slice(0, lastDash);
  const secondsRaw = rest.slice(lastDash + 1);
  if (matchId.length === 0 || !/^\d+$/.test(secondsRaw)) {
    return null;
  }
  return { matchId, seconds: Number(secondsRaw) };
}
