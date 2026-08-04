import type { Database } from 'firebase-admin/database';
import {
  deriveReviewAtCandidate,
  normalizePrepBriefRecord,
  prepBriefRecordSchema,
  PREP_LIKELY_OPPONENTS_MAX,
  REVIEW_CHECKLIST_ITEM_IDS,
  scoutBindingRecordSchema,
  type PrepBrief,
  type PrepBriefRecord,
  type PrepChecklistItemId,
  type ReviewChecklistItemId,
  type ScoutBinding,
  type TournamentEntry,
} from '@smash-tracker/shared';
import { buildDomainEnvelope } from '../events/envelope.js';
import { createEvent } from '../events/ledger.js';
import { ConflictError, NotFoundError, ValidationError } from '../services/rtdb.js';

/**
 * Phase 26 (D-22): this is the ONLY module in the API allowed to read or
 * write `prepBriefs/{uid}/{entryKey}`. It deliberately has no dependency on
 * the reports subsystem, the billing subsystem, or the Anthropic SDK —
 * that absence is what makes PREP-02's "zero model calls, zero report
 * jobs, zero credit movement" property structurally provable by an
 * import-graph gate (`importGraph.test.ts`) rather than merely asserted in
 * prose. Every
 * function below takes `database: Database` first and `uid: string`
 * second, and `uid` is always the caller's own VERIFIED uid supplied by the
 * route layer (D-12 / access control) — never read from a request body or
 * query param.
 *
 * Phase 27 (RPT-01/RPT-02, 27-06): this module now ALSO owns
 * `prepBriefs/{uid}/{entryKey}/scoutBindings` — the sibling map of
 * confirmed player identities for curated opponents, never a replacement
 * for `likelyOpponents`. This module STILL has no dependency on the
 * reports subsystem, the billing subsystem, or the Anthropic SDK: provider
 * resolution (the actual start.gg/parry.gg lookups) deliberately lives one
 * layer up, in `apps/api/src/routes/prepBindings.ts`, which calls the
 * setters below only with an ALREADY-resolved `ScoutBinding` — this module
 * never talks to a provider itself.
 */

export const PREP_BRIEF_ROOT = 'prepBriefs';

/**
 * The single path-builder every prep read/write goes through, so no call
 * site hand-concatenates `prepBriefs/{uid}/{entryKey}` itself.
 */
export function prepBriefPath(uid: string, entryKey: string): string {
  return `${PREP_BRIEF_ROOT}/${uid}/${entryKey}`;
}

/**
 * D-12 (read/write separation): a single `.get()` on the brief path. This
 * is the pure-read path — it performs NO write of any kind. Any future
 * edit that adds a write here breaks this phase's read/write separation
 * contract; the brief's activation/reopen/mutation functions below are the
 * ONLY places allowed to write this tree.
 */
export async function readPrepBrief(
  database: Database,
  uid: string,
  entryKey: string,
): Promise<PrepBrief | null> {
  const snapshot = await database.ref(prepBriefPath(uid, entryKey)).get();
  if (!snapshot.exists()) {
    return null;
  }
  const record = prepBriefRecordSchema.parse(snapshot.val());
  return normalizePrepBriefRecord(record);
}

/**
 * Create-once activation (D-02, D-07): guards first-activation with a
 * direct write-once `.transaction()` on the brief record itself — the same
 * shape as `RtdbService.upsertUser`'s `referredByShareId` write-once
 * transaction (`apps/api/src/services/rtdb.ts`).
 *
 * CR-01 semantics: the update function is ALWAYS invoked with `null` on its
 * first run (the SDK's local-cache-first behavior on a listener-less
 * server process), regardless of the real stored state. On a genuinely
 * empty node, `current == null` is true and the fresh record commits
 * directly (fast path). On a populated node, that first-run guess
 * mismatches the real stored hash, so the SDK re-runs the update function
 * with the ACTUAL current value — at which point `current == null`
 * correctly evaluates false and the function returns `undefined` (abort,
 * no overwrite). This means exactly one caller ever observes
 * `committed: true` under concurrency or retry, and a replay can never
 * rewrite the immutable `eventDate` snapshot (D-02).
 */
export async function activatePrepBrief(
  database: Database,
  uid: string,
  entryKey: string,
  eventDate: number,
  sessionId: string,
): Promise<{ brief: PrepBrief; justActivated: boolean }> {
  const initial: PrepBriefRecord = {
    eventDate,
    activatedAt: Date.now(),
    lastOpenedAt: Date.now(),
    // No `checklist`/`likelyOpponents` keys at all on first activation —
    // D-20 conditional-spread discipline: an empty map is never written.
  };

  const result = await database
    .ref(prepBriefPath(uid, entryKey))
    .transaction((current) => (current == null ? initial : undefined));

  const record = prepBriefRecordSchema.parse(result.snapshot.val());
  const brief = normalizePrepBriefRecord(record);

  if (result.committed === true) {
    // RESEARCH Pitfall 3: the causation value is EXACTLY the colon-joined
    // uid and entryKey — no timestamp, no random suffix, no open ID. A
    // per-call value would defeat createEvent's own eventDedup transaction
    // and manufacture phantom activations on every client retry. The
    // payload is the empty object: content-free, carrying no entryKey, no
    // event name, no opponent tag.
    await createEvent(
      database,
      buildDomainEnvelope({
        eventName: 'prep_brief_activated',
        actorId: uid,
        sessionId,
        causationId: `${uid}:${entryKey}`,
        consentState: 'unknown',
        payload: {},
      }),
    );
  }

  return { brief, justActivated: result.committed };
}

/**
 * Reopen (D-08): never creates — a reopen is deliberately unable to bring a
 * brief into existence (that is activation's job alone), so a missing node
 * throws `NotFoundError`. Otherwise stamps `lastOpenedAt` and emits
 * `prep_brief_reopened`, deduped via a stable, client-generated `openId`:
 * the client mints `openId` once per logical page mount and reuses it
 * across transport retries of that SAME mount, so a retried request
 * collapses into the same ledger row (via createEvent's own eventDedup
 * transaction keyed on this exact causationId), while a genuinely new
 * mount mints a fresh openId and produces a new, legitimate reopen event.
 * Leaves `checklist`/`likelyOpponents` completely untouched.
 */
export async function reopenPrepBrief(
  database: Database,
  uid: string,
  entryKey: string,
  openId: string,
  sessionId: string,
): Promise<PrepBrief> {
  const existing = await readPrepBrief(database, uid, entryKey);
  if (existing === null) {
    throw new NotFoundError(`Prep brief not found for entryKey ${entryKey}`);
  }

  await database.ref(`${prepBriefPath(uid, entryKey)}/lastOpenedAt`).set(Date.now());

  const brief = await readPrepBrief(database, uid, entryKey);
  if (brief === null) {
    throw new NotFoundError(`Prep brief not found for entryKey ${entryKey}`);
  }

  await createEvent(
    database,
    buildDomainEnvelope({
      eventName: 'prep_brief_reopened',
      actorId: uid,
      sessionId,
      causationId: `${uid}:${entryKey}:${openId}`,
      consentState: 'unknown',
      payload: {},
    }),
  );

  return brief;
}

/**
 * Phase 28 (REV-01, owner invariants 3 & 5): the write-once conversion
 * freeze. Mirrors `activatePrepBrief`'s CR-01 create-once transaction shape
 * above (lines 88-131), but applied to a single CHILD field (`reviewAt`)
 * rather than the whole brief record, so it can ride ALONGSIDE the
 * activate/open mutations without re-creating the brief itself.
 *
 * GET must NEVER call this (D-12 read/write separation, RESEARCH — "GET
 * never writes"). The durable first-open write that fires
 * `post_event_review_started` (owner invariant 3) IS this commit, and it
 * must ride the activate/open mutations only — see `routes/prep.ts` (28-04).
 *
 * Once `reviewAt` is present on the stored record, this function returns
 * immediately with NO re-derivation from `entry` — the registry row
 * (`lastSetAt`/`firstSetAt`) is consulted ONLY while `reviewAt` is still
 * absent. This is the mechanism behind owner invariant 5 (never-flip-back):
 * a later sync that moves `lastSetAt` into the future cannot un-convert an
 * already-frozen brief, because the freeze commit itself is guarded by the
 * SAME field-level write-once transaction shape that makes
 * `activatePrepBrief` replay-proof — a second caller's `current == null`
 * check evaluates false against the real stored value and the update
 * function aborts (returns `undefined`), never overwriting the
 * first-committed snapshot.
 */
export async function freezeReviewAtIfDue(
  database: Database,
  uid: string,
  entryKey: string,
  entry: TournamentEntry | null,
  sessionId: string,
): Promise<{ frozen: boolean; reviewAt?: number }> {
  const existing = await readPrepBrief(database, uid, entryKey);
  if (existing === null) {
    // No activated brief → no review surface (28-CONTEXT.md).
    return { frozen: false };
  }
  if (existing.reviewAt != null) {
    // Already converted — deliberately NO re-derivation from `entry`, ever.
    return { frozen: false, reviewAt: existing.reviewAt };
  }
  if (entry === null) {
    // Registry row unreadable (e.g. removed) — no candidate to freeze.
    return { frozen: false };
  }

  const candidate = deriveReviewAtCandidate(entry);
  if (candidate > Date.now()) {
    // Not due yet — no write, no event, brief unchanged.
    return { frozen: false };
  }

  const result = await database
    .ref(`${prepBriefPath(uid, entryKey)}/reviewAt`)
    .transaction((current) => (current == null ? candidate : undefined));

  if (result.committed !== true) {
    // Lost the race (or a concurrent caller already froze it) — no event.
    return { frozen: false };
  }

  // RESEARCH Pitfall 7 (same discipline as `activatePrepBrief`'s comment
  // above): the causation value is exactly `${uid}:${entryKey}` — no
  // timestamp, no random suffix. A per-call value would defeat
  // createEvent's own eventDedup transaction and manufacture a phantom
  // second `post_event_review_started` on a retried mutation. The payload
  // is the empty object: content-free, carrying no entryKey, no event name.
  await createEvent(
    database,
    buildDomainEnvelope({
      eventName: 'post_event_review_started',
      actorId: uid,
      sessionId,
      causationId: `${uid}:${entryKey}`,
      consentState: 'unknown',
      payload: {},
    }),
  );

  return { frozen: true, reviewAt: candidate };
}

/**
 * Checklist toggle (D-19/D-20). `itemId` is typed `PrepChecklistItemId` —
 * the route layer constrains the request param with
 * `z.enum(PREP_CHECKLIST_ITEM_IDS)` before this function is ever reached
 * (RESEARCH Pitfall 4), so this module trusts the caller's typed value.
 * Writing `null` for `checked: false` is the conditional-spread/
 * never-empty-object discipline: RTDB strips the parent `checklist` node
 * entirely once its last key is removed, which is exactly why the stored
 * read schema is `.nullish()` (260725-juj incident class). No event is
 * emitted — checklist toggles are not a catalogued event this phase.
 */
export async function setPrepChecklistItem(
  database: Database,
  uid: string,
  entryKey: string,
  itemId: PrepChecklistItemId,
  checked: boolean,
): Promise<PrepBrief> {
  const existing = await readPrepBrief(database, uid, entryKey);
  if (existing === null) {
    throw new NotFoundError(`Prep brief not found for entryKey ${entryKey}`);
  }

  await database
    .ref(`${prepBriefPath(uid, entryKey)}/checklist/${itemId}`)
    .set(checked ? true : null);

  const brief = await readPrepBrief(database, uid, entryKey);
  if (brief === null) {
    throw new NotFoundError(`Prep brief not found for entryKey ${entryKey}`);
  }
  return brief;
}

/**
 * Phase 28 (REV-01/REV-02, owner invariant 4): the review checklist toggle
 * — mirrors `setPrepChecklistItem` above (single-child presence-map write,
 * `.nullish()` stored read) but on the SIBLING `reviewChecklist` map, and
 * additionally guards the ONE-TIME `reviewCompletedAt` completion marker.
 *
 * `itemId` is validated against `REVIEW_CHECKLIST_ITEM_IDS` here even
 * though the route layer (28-04's `PUT .../review-checklist/:itemId`)
 * already constrains it with `z.enum(...)` before this function is ever
 * reached — defence in depth, mirroring `PrepChecklistItemId`'s route-level
 * guard (Pitfall 4) so this module never trusts an un-typed caller.
 *
 * On the FIRST toggle whose read-back shows every `REVIEW_CHECKLIST_ITEM_IDS`
 * entry present, a field-level write-once transaction (the same CR-01 shape
 * as `activatePrepBrief`/`freezeReviewAtIfDue` above) commits
 * `reviewCompletedAt` and emits `post_event_review_completed` — ONLY on
 * that transaction's `committed === true`. Unchecking an item later never
 * deletes `reviewCompletedAt` (it is a historical fact, not a live state
 * mirror — see the stored-schema doc comment in `packages/shared/src/prep.ts`),
 * so re-completing the checklist afterward finds the marker already present
 * and the write-once transaction aborts silently — no second event, ever
 * (owner invariant 4, verbatim: "unchecking something later does not erase
 * or re-emit that historical event"). Belt-and-suspenders: even if two
 * concurrent completing toggles both observed "complete" in their own
 * read-back, `createEvent`'s own `eventDedup` transaction on the stable
 * `${uid}:${entryKey}` causationId collapses any such race to one ledger row.
 */
export async function setPrepReviewChecklistItem(
  database: Database,
  uid: string,
  entryKey: string,
  itemId: ReviewChecklistItemId,
  checked: boolean,
  sessionId: string,
): Promise<PrepBrief> {
  if (!REVIEW_CHECKLIST_ITEM_IDS.includes(itemId)) {
    throw new ValidationError(`Unknown review checklist item id: ${itemId}`);
  }

  const existing = await readPrepBrief(database, uid, entryKey);
  if (existing === null) {
    throw new NotFoundError(`Prep brief not found for entryKey ${entryKey}`);
  }

  // Review WR-03 (conversion gate): the review checklist exists only on the
  // review surface — a brief that has not converted (no frozen `reviewAt`)
  // must reject this write, exactly as the synthesis POST arm does. Without
  // this gate a direct API call could check all five items pre-event,
  // committing the write-once `reviewCompletedAt` and emitting
  // `post_event_review_completed` for an event that hasn't happened — and,
  // because the marker is permanent, the genuine completion later could
  // never emit (`completed` with no preceding `started` in the funnel).
  if (existing.reviewAt == null) {
    throw new ConflictError('Review checklist is only writable after conversion to review mode');
  }

  await database
    .ref(`${prepBriefPath(uid, entryKey)}/reviewChecklist/${itemId}`)
    .set(checked ? true : null);

  const brief = await readPrepBrief(database, uid, entryKey);
  if (brief === null) {
    throw new NotFoundError(`Prep brief not found for entryKey ${entryKey}`);
  }

  const isNowComplete =
    checked && REVIEW_CHECKLIST_ITEM_IDS.every((id) => brief.reviewChecklist[id] === true);

  if (!isNowComplete) {
    return brief;
  }

  const result = await database
    .ref(`${prepBriefPath(uid, entryKey)}/reviewCompletedAt`)
    .transaction((current) => (current == null ? Date.now() : undefined));

  if (result.committed !== true) {
    // Marker already present (a prior completion) — silent, no event, ever.
    return brief;
  }

  await createEvent(
    database,
    buildDomainEnvelope({
      eventName: 'post_event_review_completed',
      actorId: uid,
      sessionId,
      causationId: `${uid}:${entryKey}`,
      consentState: 'unknown',
      payload: {},
    }),
  );

  const updated = await readPrepBrief(database, uid, entryKey);
  if (updated === null) {
    throw new NotFoundError(`Prep brief not found for entryKey ${entryKey}`);
  }
  return updated;
}

/**
 * Likely-opponent curation (D-19/D-20). `canonicalName` is normalized
 * through `opponentNameInputSchema` by the route layer before this is
 * called. Enforces `PREP_LIKELY_OPPONENTS_MAX` server-side: a caller may
 * always re-select an already-present name even at the cap (idempotent
 * re-add — the map size doesn't grow), but adding a genuinely NEW name
 * once the map already holds the max is rejected with `ConflictError`. No
 * event is emitted — opponent selection is not a catalogued event this
 * phase.
 *
 * Phase 27 (27-06): un-curating (`selected === false`) clears BOTH
 * `likelyOpponents/{canonicalName}` and `scoutBindings/{canonicalName}` in
 * ONE root-level multi-path `update()`, so the two writes commit
 * atomically together — never as two separate `.set()` calls that could
 * observably land apart. This is the actual mechanism behind the
 * scoutBinding contract's "no silent identity" guarantee: without it, a
 * player could un-curate an opponent, have a DIFFERENT real person start
 * using that same gamer tag, and re-curate — silently inheriting the
 * PREVIOUS person's confirmed provider identity on the new curation. The
 * `selected === true` branch is untouched: (re-)curating never touches
 * `scoutBindings` itself, so a genuine re-add of the SAME opponent (no
 * intervening un-curate) keeps any binding confirmed while they were
 * curated the first time.
 */
export async function setPrepLikelyOpponent(
  database: Database,
  uid: string,
  entryKey: string,
  canonicalName: string,
  selected: boolean,
): Promise<PrepBrief> {
  const existing = await readPrepBrief(database, uid, entryKey);
  if (existing === null) {
    throw new NotFoundError(`Prep brief not found for entryKey ${entryKey}`);
  }

  if (selected && !(canonicalName in existing.likelyOpponents)) {
    const currentSize = Object.keys(existing.likelyOpponents).length;
    if (currentSize >= PREP_LIKELY_OPPONENTS_MAX) {
      throw new ConflictError(`Likely opponent limit reached (${PREP_LIKELY_OPPONENTS_MAX})`);
    }
  }

  if (selected) {
    await database
      .ref(`${prepBriefPath(uid, entryKey)}/likelyOpponents/${canonicalName}`)
      .set(true);
  } else {
    const briefPath = prepBriefPath(uid, entryKey);
    await database.ref().update({
      [`${briefPath}/likelyOpponents/${canonicalName}`]: null,
      [`${briefPath}/scoutBindings/${canonicalName}`]: null,
    });
  }

  const brief = await readPrepBrief(database, uid, entryKey);
  if (brief === null) {
    throw new NotFoundError(`Prep brief not found for entryKey ${entryKey}`);
  }
  return brief;
}

/**
 * Confirms (or overwrites) one curated opponent's scout binding (RPT-01,
 * 27-06). `binding` must already be the SERVER-RESOLVED identity — this
 * function does no provider lookup of its own (see the module doc comment
 * above); the caller (`routes/prepBindings.ts`) is responsible for
 * resolving it before calling here.
 *
 * A binding may only exist for a currently curated opponent (T-27-25): the
 * ConflictError below fires BEFORE any write, so a binding can never be
 * attached to an opponent absent from `likelyOpponents`.
 *
 * D-20 discipline (mirroring `activatePrepBrief`'s "no empty keys at all"
 * comment): the stored record is built via `scoutBindingRecordSchema.parse`
 * over a conditional-spread object, so an absent optional identity field
 * is genuinely OMITTED from what gets written — never an explicit
 * `undefined`/`null`/`''` — and a malformed binding can never reach RTDB.
 */
export async function setPrepScoutBinding(
  database: Database,
  uid: string,
  entryKey: string,
  canonicalName: string,
  binding: ScoutBinding,
): Promise<PrepBrief> {
  const existing = await readPrepBrief(database, uid, entryKey);
  if (existing === null) {
    throw new NotFoundError(`Prep brief not found for entryKey ${entryKey}`);
  }

  if (!(canonicalName in existing.likelyOpponents)) {
    throw new ConflictError('A scout binding may only be set for a currently curated opponent');
  }

  const record = scoutBindingRecordSchema.parse({
    provider: binding.provider,
    ...(binding.startggPlayerId != null ? { startggPlayerId: binding.startggPlayerId } : {}),
    ...(binding.startggUserSlug != null ? { startggUserSlug: binding.startggUserSlug } : {}),
    ...(binding.parryUserId != null ? { parryUserId: binding.parryUserId } : {}),
    displayTag: binding.displayTag,
    method: binding.method,
    confirmedAt: binding.confirmedAt,
  });

  await database.ref(`${prepBriefPath(uid, entryKey)}/scoutBindings/${canonicalName}`).set(record);

  const brief = await readPrepBrief(database, uid, entryKey);
  if (brief === null) {
    throw new NotFoundError(`Prep brief not found for entryKey ${entryKey}`);
  }
  return brief;
}

/**
 * Clears one curated opponent's scout binding, leaving `likelyOpponents`
 * completely untouched (un-curating is `setPrepLikelyOpponent`'s job, and
 * IT clears the binding too — see that function's doc comment). RTDB
 * strips the parent `scoutBindings` map entirely once the last key is
 * removed, which is exactly why `prepBriefRecordSchema.scoutBindings` is
 * `.nullish()` (260725-juj null-strip-tolerance class) — a subsequent read
 * normalizes back to `{}` regardless.
 */
export async function clearPrepScoutBinding(
  database: Database,
  uid: string,
  entryKey: string,
  canonicalName: string,
): Promise<PrepBrief> {
  const existing = await readPrepBrief(database, uid, entryKey);
  if (existing === null) {
    throw new NotFoundError(`Prep brief not found for entryKey ${entryKey}`);
  }

  await database.ref(`${prepBriefPath(uid, entryKey)}/scoutBindings/${canonicalName}`).set(null);

  const brief = await readPrepBrief(database, uid, entryKey);
  if (brief === null) {
    throw new NotFoundError(`Prep brief not found for entryKey ${entryKey}`);
  }
  return brief;
}
