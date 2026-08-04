import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  deriveReviewAtCandidate,
  entryKeyInputSchema,
  opponentNameInputSchema,
  PREP_CHECKLIST_ITEM_IDS,
  prepActivateResponseSchema,
  prepBriefResponseSchema,
  prepBriefStatusSchema,
  prepChecklistItemUpdateSchema,
  prepOpenRequestSchema,
  REVIEW_CHECKLIST_ITEM_IDS,
  tournamentEntrySchema,
  type TournamentEntry,
} from '@smash-tracker/shared';
import {
  activatePrepBrief,
  freezeReviewAtIfDue,
  readPrepBrief,
  reopenPrepBrief,
  setPrepChecklistItem,
  setPrepLikelyOpponent,
  setPrepReviewChecklistItem,
} from '../prep/prep.js';
import { NotFoundError } from '../services/rtdb.js';

/** `X-Session-Id` header, copied verbatim from `tournaments.ts` — defaults to `'unknown'`, never blocks the request. */
function sessionIdFromHeader(request: FastifyRequest): string {
  const header = request.headers['x-session-id'];
  const value = Array.isArray(header) ? header[0] : header;
  return value ?? 'unknown';
}

/**
 * Reads `tournamentEntries/{uid}/{entryKey}`, stamping `entryKey` from the
 * child key exactly as `GET /tournaments` does — a TOLERANT read: an absent
 * row returns `null` rather than throwing. Phase 28 (28-04): both the GET
 * handler's effective-`reviewAt` derivation and the open handler's freeze
 * wiring need the registry row WITHOUT 404ing when it's missing (D-03: a
 * brief must stay reachable even if its registry row is later removed).
 * `requireOwnedEntry` below is the throwing wrapper every existing call site
 * (activate) keeps using unchanged.
 */
async function tryReadOwnedEntry(
  app: FastifyInstance,
  uid: string,
  entryKey: string,
): Promise<TournamentEntry | null> {
  const snapshot = await app.firebase.database.ref(`tournamentEntries/${uid}/${entryKey}`).get();
  if (!snapshot.exists()) {
    return null;
  }
  return tournamentEntrySchema.parse({
    ...(snapshot.val() as object),
    entryKey,
  });
}

/**
 * Throws `NotFoundError` when the row is absent. This is an
 * EXISTENCE/OWNERSHIP check, not character sanitization: an `entryKey` that
 * names a real RTDB child key is by construction free of RTDB-illegal
 * characters, because the write that created it would otherwise have been
 * rejected (RESEARCH Pitfall 2). Re-scrubbing it here would be theatre;
 * refusing an entryKey the caller does not own is the actual control
 * (T-26-15).
 */
async function requireOwnedEntry(
  app: FastifyInstance,
  uid: string,
  entryKey: string,
): Promise<TournamentEntry> {
  const entry = await tryReadOwnedEntry(app, uid, entryKey);
  if (entry === null) {
    throw new NotFoundError(`Tournament entry not found for entryKey ${entryKey}`);
  }
  return entry;
}

/**
 * `entryKey` is interpolated directly into `database.ref(...)` paths
 * (`prepBriefPath`, `requireOwnedEntry`), so it must reject the same
 * RTDB-reserved path characters `opponentNameInputSchema` rejects for the
 * sibling `:name` param on this same file — otherwise an illegal-character
 * value passes Zod validation and the real firebase-admin SDK throws
 * synchronously on `Reference.child`, surfacing as an uncaught 500 instead
 * of a clean 400. Deliberately NOT reusing `opponentNameInputSchema`
 * itself: that schema trims and lowercases, which would corrupt `entryKey`
 * (a case-sensitive, already-generated key that must match the stored
 * child key byte-for-byte) — only the illegal-character rejection applies
 * here.
 *
 * Phase 27 (RESEARCH.md Pitfall 7): the validator itself now lives in
 * `packages/shared/src/prep.ts` (`entryKeyInputSchema`) rather than being
 * duplicated locally, because Phase 27 introduces three more call sites for
 * the exact same rule (`prepBindings.ts`, `billing.ts`, `reports.ts`) — one
 * shared definition keeps them from drifting apart.
 */
const prepParamsSchema = z.object({
  entryKey: entryKeyInputSchema,
});

const prepChecklistParamsSchema = prepParamsSchema.extend({
  itemId: z.enum(PREP_CHECKLIST_ITEM_IDS),
});

/** Phase 28 (28-04): the review checklist's own closed itemId enum — a SIBLING param schema, never sharing the prep checklist's `PREP_CHECKLIST_ITEM_IDS`. */
const prepReviewChecklistParamsSchema = prepParamsSchema.extend({
  itemId: z.enum(REVIEW_CHECKLIST_ITEM_IDS),
});

const prepOpponentParamsSchema = prepParamsSchema.extend({
  name: opponentNameInputSchema,
});

/**
 * Phase 27 (RPT-04): whether the caller may see the paid prep surface.
 * Computed one layer above this module in `apps/api/src/app.ts` — from the
 * activation flag AND the reports config AND the stripe config — and passed
 * in as a plain boolean so this file (and the whole `apps/api/src/prep/`
 * tree it calls into) never needs to know ReportsConfig or StripeConfig
 * exist (the import-graph gate this module's tests enforce).
 */
export interface PrepRoutesOptions {
  paidReportsAvailable: boolean;
}

/**
 * Phase 26 (PREP-01..04, D-22): the free deterministic tournament prep
 * brief, addressed only by `request.uid` — NO `app.resolveSubject`.
 * `prepBriefs` is keyed on uid exactly like the `tournamentEntries` tree it
 * attaches to, so this module follows `tournaments.ts`, not `opponents.ts`;
 * opting into subject resolution would let a coach's client-workspace
 * session address a different uid's brief tree (RESEARCH Pitfall 5,
 * T-26-16). Every handler below reads `request.uid` directly.
 */
const prepRoutes: FastifyPluginAsyncZod<PrepRoutesOptions> = async (app, options) => {
  app.addHook('preHandler', app.authenticate);

  // GET /api/prep/:entryKey — D-12: a pure read, no writes. An existing
  // brief must stay readable even after its event date passes (D-03) and
  // even if the registry row were later removed. Do NOT add an ownership
  // guard here — a later "tidy-up" that checks tournamentEntries first
  // would 404 a legitimately past-dated brief. No ownership check is
  // needed anyway: the brief tree is already scoped to request.uid.
  app.get(
    '/prep/:entryKey',
    {
      schema: {
        params: prepParamsSchema,
        response: {
          200: prepBriefStatusSchema,
        },
      },
    },
    async (request) => {
      const brief = await readPrepBrief(
        app.firebase.database,
        request.uid,
        request.params.entryKey,
      );
      // Phase 27 (RPT-04): returned unconditionally, in BOTH shapes below,
      // by every new server — deploy-order compatibility (an old client
      // parsing this response simply ignores the extra field). Clients must
      // treat only a strict `true` as enabling the paid surface;
      // `undefined`/`false` both mean "not available".
      if (brief === null) {
        return { activated: false, paidReportsAvailable: options.paidReportsAvailable };
      }
      // Phase 28 (REV-01): the EFFECTIVE reviewAt the client renders mode
      // from — the frozen value when present, otherwise a server-derived
      // PROVISIONAL candidate from a tolerant registry read. This function
      // performs NO write of any kind (D-12 stays intact): the durable
      // freeze rides the activate/open mutations only, never this GET.
      let reviewAt = brief.reviewAt;
      if (reviewAt == null) {
        const entry = await tryReadOwnedEntry(app, request.uid, request.params.entryKey);
        if (entry !== null) {
          reviewAt = deriveReviewAtCandidate(entry);
        }
      }
      return {
        activated: true,
        brief,
        paidReportsAvailable: options.paidReportsAvailable,
        ...(reviewAt != null ? { reviewAt } : {}),
      };
    },
  );

  // POST /api/prep/:entryKey/activate — create-once activation (D-02/D-07).
  // requireOwnedEntry runs FIRST: an entryKey absent from the caller's own
  // registry is refused with 404 before any prepBriefs path is touched.
  app.post(
    '/prep/:entryKey/activate',
    {
      schema: {
        params: prepParamsSchema,
        response: {
          200: prepActivateResponseSchema,
        },
      },
    },
    async (request) => {
      const entry = await requireOwnedEntry(app, request.uid, request.params.entryKey);
      const sessionId = sessionIdFromHeader(request);
      // The eventDate argument is the registry row's firstSetAt — the
      // immutable snapshot D-02 requires. The service's create-once
      // transaction guarantees a replay never overwrites it, so a later
      // start.gg sync that changes the registry row cannot silently rebind
      // an existing brief (D-06).
      const result = await activatePrepBrief(
        app.firebase.database,
        request.uid,
        request.params.entryKey,
        entry.firstSetAt,
        sessionId,
      );
      // Phase 28 (REV-01, owner invariant 3): activating a brief for an
      // event whose reviewAt candidate is already past (the archival/
      // backfill case) converts on first visit — freezeReviewAtIfDue is a
      // no-op unless the candidate is due, so a genuinely future event is
      // untouched. Re-read AFTER the freeze so the response's
      // `brief.reviewAt` reflects it.
      await freezeReviewAtIfDue(
        app.firebase.database,
        request.uid,
        request.params.entryKey,
        entry,
        sessionId,
      );
      const brief = await readPrepBrief(
        app.firebase.database,
        request.uid,
        request.params.entryKey,
      );
      if (brief === null) {
        throw new NotFoundError(`Prep brief not found for entryKey ${request.params.entryKey}`);
      }
      return { justActivated: result.justActivated, brief };
    },
  );

  // POST /api/prep/:entryKey/open — reopen (D-08). No requireOwnedEntry
  // call: a brief that exists is by definition the caller's own (it lives
  // under prepBriefs/{request.uid}/...), and requiring the registry row
  // here would break D-03 reachability for a past-dated event.
  app.post(
    '/prep/:entryKey/open',
    {
      schema: {
        params: prepParamsSchema,
        body: prepOpenRequestSchema,
        response: {
          200: prepBriefResponseSchema,
        },
      },
    },
    async (request) => {
      const sessionId = sessionIdFromHeader(request);
      await reopenPrepBrief(
        app.firebase.database,
        request.uid,
        request.params.entryKey,
        request.body.openId,
        sessionId,
      );
      // Phase 28 (REV-01, owner invariant 3): "existing briefs whose events
      // passed before Phase 28 ships convert too" — a tolerant registry
      // read (absent row = no candidate, NOT a 404: D-03 reachability for a
      // past-dated event must survive a removed registry row).
      const entry = await tryReadOwnedEntry(app, request.uid, request.params.entryKey);
      await freezeReviewAtIfDue(
        app.firebase.database,
        request.uid,
        request.params.entryKey,
        entry,
        sessionId,
      );
      const brief = await readPrepBrief(
        app.firebase.database,
        request.uid,
        request.params.entryKey,
      );
      if (brief === null) {
        throw new NotFoundError(`Prep brief not found for entryKey ${request.params.entryKey}`);
      }
      return { brief };
    },
  );

  // PUT /api/prep/:entryKey/checklist/:itemId — the itemId enum param (see
  // prepChecklistParamsSchema above) is the defence in Pitfall 4: an unknown
  // item id fails Zod validation and returns 400 before any RTDB path string
  // is built, so the presence map can never drift from the fixed 7-item
  // contract (T-26-17).
  app.put(
    '/prep/:entryKey/checklist/:itemId',
    {
      schema: {
        params: prepChecklistParamsSchema,
        body: prepChecklistItemUpdateSchema,
        response: {
          200: prepBriefResponseSchema,
        },
      },
    },
    async (request) => {
      const brief = await setPrepChecklistItem(
        app.firebase.database,
        request.uid,
        request.params.entryKey,
        request.params.itemId,
        request.body.checked,
      );
      return { brief };
    },
  );

  // PUT /api/prep/:entryKey/review-checklist/:itemId — Phase 28 (28-04):
  // the review checklist's own closed itemId enum (prepReviewChecklistParamsSchema
  // above) mirrors the prep checklist PUT's defence in Pitfall 4 — an unknown
  // item id fails Zod validation and returns 400 before any RTDB path string
  // is built. `setPrepReviewChecklistItem` owns the fire-once
  // `post_event_review_completed` emission (owner invariant 4).
  app.put(
    '/prep/:entryKey/review-checklist/:itemId',
    {
      schema: {
        params: prepReviewChecklistParamsSchema,
        body: prepChecklistItemUpdateSchema,
        response: {
          200: prepBriefResponseSchema,
        },
      },
    },
    async (request) => {
      const brief = await setPrepReviewChecklistItem(
        app.firebase.database,
        request.uid,
        request.params.entryKey,
        request.params.itemId,
        request.body.checked,
        sessionIdFromHeader(request),
      );
      return { brief };
    },
  );

  // PUT /api/prep/:entryKey/opponents/:name — curate a likely opponent.
  // opponentNameInputSchema trims/lowercases and rejects RTDB-illegal
  // characters (T-26-18), the same validator the opponents surface already
  // uses. The service's ConflictError on the curated-list bound maps to 409
  // through the existing global handler — no local try/catch needed.
  app.put(
    '/prep/:entryKey/opponents/:name',
    {
      schema: {
        params: prepOpponentParamsSchema,
        response: {
          200: prepBriefResponseSchema,
        },
      },
    },
    async (request) => {
      const brief = await setPrepLikelyOpponent(
        app.firebase.database,
        request.uid,
        request.params.entryKey,
        request.params.name,
        true,
      );
      return { brief };
    },
  );

  // DELETE /api/prep/:entryKey/opponents/:name — un-curate a likely opponent.
  app.delete(
    '/prep/:entryKey/opponents/:name',
    {
      schema: {
        params: prepOpponentParamsSchema,
        response: {
          200: prepBriefResponseSchema,
        },
      },
    },
    async (request) => {
      const brief = await setPrepLikelyOpponent(
        app.firebase.database,
        request.uid,
        request.params.entryKey,
        request.params.name,
        false,
      );
      return { brief };
    },
  );
};

export default prepRoutes;
