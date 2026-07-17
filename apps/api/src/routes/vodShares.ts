import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import {
  createShareInputSchema,
  errorResponseSchema,
  shareCreatedResponseSchema,
  shareSummarySchema,
} from '@smash-tracker/shared';
import { z } from 'zod';
import { ForbiddenError, RtdbService, ValidationError } from '../services/rtdb.js';

const shareIdParamsSchema = z.object({
  id: z.string().min(1),
});

export interface VodSharesRoutesOptions {
  /** SPA origin the share url is built against, e.g. `${webBaseUrl}/s/{token}` (env.WEB_BASE_URL). */
  webBaseUrl: string;
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
 */
const vodSharesRoutes: FastifyPluginAsyncZod<VodSharesRoutesOptions> = async (app, options) => {
  const rtdb = new RtdbService(app.firebase.database);
  const { webBaseUrl } = options;

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

  // DELETE /api/vod-shares/:id — hard-deletes a REVOKED share (list hygiene).
  // Active shares 409 (ConflictError → global handler): revoke is the only
  // way to end access; delete only clears the dead record afterward.
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
};

export default vodSharesRoutes;
