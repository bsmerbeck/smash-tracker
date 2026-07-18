import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import {
  bulkShareRequestSchema,
  bulkShareResponseSchema,
  createShareInputSchema,
  errorResponseSchema,
  shareCreatedResponseSchema,
  shareSummarySchema,
} from '@smash-tracker/shared';
import { z } from 'zod';
import { reviewShared } from '../analytics/ga4.js';
import type { Ga4Config } from '../config/env.js';
import { ForbiddenError, RtdbService, ValidationError } from '../services/rtdb.js';

const shareIdParamsSchema = z.object({
  id: z.string().min(1),
});

export interface VodSharesRoutesOptions {
  /** SPA origin the share url is built against, e.g. `${webBaseUrl}/s/{token}` (env.WEB_BASE_URL). */
  webBaseUrl: string;
  /**
   * GA4 Measurement Protocol config; null/omitted makes the fire-and-forget
   * `review_shared` event a silent no-op (Phase 7 — never a 503, this route
   * pre-dates and does not depend on GA4).
   */
  ga4?: Ga4Config | null;
  /** Overridable fetch for the GA4 Measurement Protocol POST (tests). */
  ga4Fetch?: typeof fetch;
}

/**
 * VOD Manager overhaul, Phase 5 (Share Foundation & Owner Controls):
 * `/api/vod-shares` — authenticated owner CRUD for privacy-controlled,
 * revocable VOD share links (see packages/shared/src/shares.ts for the
 * data-model rationale). CRUD mirrors playlists.ts almost verbatim:
 * push-keyed records, server-stamped `createdAt`, a per-user cap that
 * throws `ForbiddenError` -> 403 mapped locally (the global handler doesn't
 * know about it).
 *
 * Every read/write is scoped to `request.uid` from the authenticate
 * preHandler — never a uid from body/params/query (threat model T-05-04).
 *
 * Revoke is a dedicated `POST .../revoke` action route, not `DELETE`: a
 * revoke is a one-way soft state transition (sets `revokedAt`, never
 * removes the record — the locked "no hard delete" decision), which reads
 * more honestly as an action verb than a generic delete/patch.
 *
 * Phase 7 (Recap Cards & Share-Loop Analytics): `POST /vod-shares` also
 * accepts `{ kind: 'recap', entryKey }` — a deterministic post-tournament
 * stats card built from the caller's own `tournamentEntries/{uid}/{entryKey}`
 * + `matches/{uid}` (see `RtdbService.createShare`'s recap branch and
 * `buildRecapSnapshot`). No new route topology: `ValidationError` /
 * `ForbiddenError` / `NotFoundError` mapping below already covers the
 * recap-specific failure cases (a foreign/absent `entryKey` 404s the same
 * way a foreign/absent `matchId` already does).
 *
 * Walkthrough amendment (07-09): the same body also accepts an optional
 * `detail: 'summary' | 'full'` (meaningful only for `kind: 'recap'`) —
 * `RtdbService.createShare` treats an absent value as `'full'` before
 * calling `buildRecapSnapshot`. Still no new route topology; `detail` rides
 * inside the existing `createShareInputSchema` body.
 */
const vodSharesRoutes: FastifyPluginAsyncZod<VodSharesRoutesOptions> = async (app, options) => {
  const rtdb = new RtdbService(app.firebase.database);
  const { webBaseUrl, ga4Fetch } = options;
  const ga4 = options.ga4 ?? null;

  app.addHook('preHandler', app.authenticate);

  // POST /api/vod-shares
  app.post(
    '/vod-shares',
    {
      schema: {
        body: createShareInputSchema,
        response: {
          201: shareCreatedResponseSchema,
          400: errorResponseSchema,
          403: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        const result = await rtdb.createShare(request.uid, request.body, webBaseUrl);
        // Fire-and-forget, AFTER the share is durably written — never
        // `await`ed, so a slow/failed GA4 POST can never delay or fail this
        // 201 (Pitfall 5 / T-07-07-02). `ga4` null (unconfigured) is an
        // instant no-op inside reviewShared/sendMeasurementProtocolEvent.
        void reviewShared(ga4, request.uid, request.body.kind, ga4Fetch);
        return reply.code(201).send(result);
      } catch (err) {
        if (err instanceof ForbiddenError) {
          return reply
            .code(403)
            .send({ error: 'Forbidden', message: err.message, statusCode: 403 });
        }
        if (err instanceof ValidationError) {
          return reply
            .code(400)
            .send({ error: 'Bad Request', message: err.message, statusCode: 400 });
        }
        throw err; // NotFoundError bubbles to the global 404 handler
      }
    },
  );

  // GET /api/vod-shares
  app.get(
    '/vod-shares',
    {
      schema: {
        response: {
          200: z.array(shareSummarySchema),
        },
      },
    },
    async (request) => {
      return rtdb.listSharesForUser(request.uid, webBaseUrl);
    },
  );

  // POST /api/vod-shares/:id/revoke
  app.post(
    '/vod-shares/:id/revoke',
    {
      schema: {
        params: shareIdParamsSchema,
        response: {
          204: z.undefined(),
        },
      },
    },
    async (request, reply) => {
      await rtdb.revokeShare(request.uid, request.params.id);
      return reply.code(204).send();
    },
  );

  // DELETE /api/vod-shares/:id — hard-deletes a share, ACTIVE or revoked
  // (walkthrough amendment FB-03: removing shareTokens/{token} directly
  // kills all anonymous access atomically, so an active share no longer
  // needs a revoke-first step — overrides the earlier Phase 5 "no hard
  // delete without revoke first" decision).
  app.delete(
    '/vod-shares/:id',
    {
      schema: {
        params: shareIdParamsSchema,
        response: {
          204: z.undefined(),
        },
      },
    },
    async (request, reply) => {
      await rtdb.deleteShare(request.uid, request.params.id);
      return reply.code(204).send();
    },
  );

  // POST /api/vod-shares/bulk — walkthrough amendment (FB-03, My Shares
  // management overhaul): batch revoke or delete up to MAX_SHARES_PER_USER
  // shares in ONE round-trip. Inherits the file-wide authenticate
  // preHandler (no per-route auth wiring); uid comes only from
  // `request.uid`, never body/params (T-05-04). Skip-not-fail: a
  // foreign/missing/already-revoked id is counted in `skipped`, never
  // raised as an error, so this route never needs custom error mapping —
  // body validation failures (the >100/empty/bad-action cases) are handled
  // by fastify-type-provider-zod as 400.
  app.post(
    '/vod-shares/bulk',
    {
      schema: {
        body: bulkShareRequestSchema,
        response: {
          200: bulkShareResponseSchema,
          400: errorResponseSchema,
        },
      },
    },
    async (request) =>
      rtdb.bulkUpdateShares(request.uid, request.body.action, request.body.shareIds),
  );
};

export default vodSharesRoutes;
