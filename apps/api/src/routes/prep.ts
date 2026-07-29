import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  opponentNameInputSchema,
  PREP_CHECKLIST_ITEM_IDS,
  prepActivateResponseSchema,
  prepBriefResponseSchema,
  prepBriefStatusSchema,
  prepChecklistItemUpdateSchema,
  prepOpenRequestSchema,
  tournamentEntrySchema,
  type TournamentEntry,
} from '@smash-tracker/shared';
import {
  activatePrepBrief,
  readPrepBrief,
  reopenPrepBrief,
  setPrepChecklistItem,
  setPrepLikelyOpponent,
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
 * child key exactly as `GET /tournaments` does, and throws `NotFoundError`
 * when the row is absent. This is an EXISTENCE/OWNERSHIP check, not
 * character sanitization: an `entryKey` that names a real RTDB child key is
 * by construction free of RTDB-illegal characters, because the write that
 * created it would otherwise have been rejected (RESEARCH Pitfall 2).
 * Re-scrubbing it here would be theatre; refusing an entryKey the caller
 * does not own is the actual control (T-26-15).
 */
async function requireOwnedEntry(
  app: FastifyInstance,
  uid: string,
  entryKey: string,
): Promise<TournamentEntry> {
  const snapshot = await app.firebase.database.ref(`tournamentEntries/${uid}/${entryKey}`).get();
  if (!snapshot.exists()) {
    throw new NotFoundError(`Tournament entry not found for entryKey ${entryKey}`);
  }
  return tournamentEntrySchema.parse({
    ...(snapshot.val() as object),
    entryKey,
  });
}

const prepParamsSchema = z.object({
  entryKey: z.string().min(1).max(200),
});

const prepChecklistParamsSchema = prepParamsSchema.extend({
  itemId: z.enum(PREP_CHECKLIST_ITEM_IDS),
});

const prepOpponentParamsSchema = prepParamsSchema.extend({
  name: opponentNameInputSchema,
});

/**
 * Phase 26 (PREP-01..04, D-22): the free deterministic tournament prep
 * brief, addressed only by `request.uid` — NO `app.resolveSubject`.
 * `prepBriefs` is keyed on uid exactly like the `tournamentEntries` tree it
 * attaches to, so this module follows `tournaments.ts`, not `opponents.ts`;
 * opting into subject resolution would let a coach's client-workspace
 * session address a different uid's brief tree (RESEARCH Pitfall 5,
 * T-26-16). Every handler below reads `request.uid` directly.
 */
const prepRoutes: FastifyPluginAsyncZod = async (app) => {
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
      if (brief === null) {
        return { activated: false };
      }
      return { activated: true, brief };
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
      // The eventDate argument is the registry row's firstSetAt — the
      // immutable snapshot D-02 requires. The service's create-once
      // transaction guarantees a replay never overwrites it, so a later
      // start.gg sync that changes the registry row cannot silently rebind
      // an existing brief (D-06).
      return activatePrepBrief(
        app.firebase.database,
        request.uid,
        request.params.entryKey,
        entry.firstSetAt,
        sessionIdFromHeader(request),
      );
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
      const brief = await reopenPrepBrief(
        app.firebase.database,
        request.uid,
        request.params.entryKey,
        request.body.openId,
        sessionIdFromHeader(request),
      );
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
