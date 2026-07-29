import type { Database } from 'firebase-admin/database';
import {
  normalizePrepBriefRecord,
  prepBriefRecordSchema,
  PREP_LIKELY_OPPONENTS_MAX,
  type PrepBrief,
  type PrepBriefRecord,
  type PrepChecklistItemId,
} from '@smash-tracker/shared';
import { buildDomainEnvelope } from '../events/envelope.js';
import { createEvent } from '../events/ledger.js';
import { ConflictError, NotFoundError } from '../services/rtdb.js';

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
 * Likely-opponent curation (D-19/D-20). `canonicalName` is normalized
 * through `opponentNameInputSchema` by the route layer before this is
 * called. Enforces `PREP_LIKELY_OPPONENTS_MAX` server-side: a caller may
 * always re-select an already-present name even at the cap (idempotent
 * re-add — the map size doesn't grow), but adding a genuinely NEW name
 * once the map already holds the max is rejected with `ConflictError`. No
 * event is emitted — opponent selection is not a catalogued event this
 * phase.
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

  await database
    .ref(`${prepBriefPath(uid, entryKey)}/likelyOpponents/${canonicalName}`)
    .set(selected ? true : null);

  const brief = await readPrepBrief(database, uid, entryKey);
  if (brief === null) {
    throw new NotFoundError(`Prep brief not found for entryKey ${entryKey}`);
  }
  return brief;
}
