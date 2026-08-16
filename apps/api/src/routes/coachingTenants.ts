import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  clientHubListSchema,
  clientHubRowSchema,
  clientKindResponseSchema,
  createClientRequestSchema,
  errorResponseSchema,
  fighterSelectionSchema,
  matchSchema,
  opponentAliasMapSchema,
  opponentNoteMapSchema,
  playlistSchema,
  stageFavoritesSchema,
  SUBJECT_KIND_RESOLUTIONS,
} from '@smash-tracker/shared';
import {
  archiveClient,
  createClient,
  deleteClient,
  exportClient,
  listClients,
} from '../coaching/tenants.js';
import { resolveTenantAccess } from '../research/access.js';
import { isDemoAccountSubject } from '../research/demoAccount.js';
import { isPathSafeTenantId } from '../research/subjectKind.js';
import { ConflictError, ForbiddenError, NotFoundError } from '../services/rtdb.js';

const clientIdParamsSchema = z.object({
  clientId: z.string().min(1),
});

const archiveClientBodySchema = z.object({ archived: z.boolean() }).nullish();

const listClientsQuerySchema = z.object({
  /** `?includeArchived=true` also returns soft-archived rows (TEN-06 restore path). */
  includeArchived: z.enum(['true', 'false']).optional(),
});

/**
 * Phase 29 (RTEN-01, cycle-2 finding C2-HIGH-2): the first member of the
 * shared resolution tuple is the ordinary resolution. A freshly created
 * coaching tenant (this route only ever calls the coaching `createClient`
 * wrapper) is ordinary by construction — it was written with no research
 * discriminator — so the 201 body stamps this value directly with NO
 * additional database read. Never inline a literal resolution string in the
 * handler below; the shared tuple is the only source.
 */
const [ORDINARY_SUBJECT_KIND_RESOLUTION] = SUBJECT_KIND_RESOLUTIONS;

const clientWorkspaceExportSchema = z.object({
  clientId: z.string(),
  label: z.string(),
  exportedAt: z.number().int().nonnegative(),
  matches: z.array(matchSchema),
  playlists: z.array(playlistSchema),
  opponents: z.array(z.string()),
  opponentAliases: opponentAliasMapSchema,
  opponentNotes: opponentNoteMapSchema,
  stageFavorites: stageFavoritesSchema,
  fighterSelection: fighterSelectionSchema,
});

/**
 * /api/coaching/clients — Phase 11 (Coach Workspace Tenancy & Feature
 * Parity, TEN-01/TEN-05/TEN-06): managed-client tenant CRUD + the compact
 * Client Hub listing + hard-delete cascade + JSON export.
 *
 * Uses `request.uid` DIRECTLY, never the subject-resolver preHandler/
 * `request.subjectId` pair every same-subject route opts into elsewhere —
 * managing one's OWN client tenants (create/list/archive/delete/export) is
 * a personal action performed BY the coach, not a client-scoped read/write
 * (see RESEARCH.md's `coachingTenants.ts` structure rationale). Error
 * mapping mirrors `apps/api/src/routes/groups.ts`: `ConflictError` → 409,
 * `ForbiddenError` → 403, `NotFoundError` → 404.
 */
const coachingTenantsRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.authenticate);

  // POST /api/coaching/clients
  app.post(
    '/coaching/clients',
    {
      schema: {
        body: createClientRequestSchema,
        response: {
          201: clientHubRowSchema,
          403: errorResponseSchema,
          409: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        const sessionIdHeader = request.headers['x-session-id'];
        const sessionId =
          (Array.isArray(sessionIdHeader) ? sessionIdHeader[0] : sessionIdHeader) ?? 'unknown';
        const { tenantId } = await createClient(
          app.firebase.database,
          request.uid,
          request.body.label,
          { sessionId },
        );
        return reply.code(201).send({
          clientId: tenantId,
          label: request.body.label,
          lastActivityAt: null,
          draftCount: 0,
          deliveryState: null,
          archivedAt: null,
          kind: ORDINARY_SUBJECT_KIND_RESOLUTION,
        });
      } catch (err) {
        if (err instanceof ConflictError) {
          return reply.code(409).send({ error: 'Conflict', message: err.message, statusCode: 409 });
        }
        if (err instanceof ForbiddenError) {
          return reply
            .code(403)
            .send({ error: 'Forbidden', message: err.message, statusCode: 403 });
        }
        throw err;
      }
    },
  );

  // GET /api/coaching/clients — pass ?includeArchived=true to also list
  // soft-archived clients (the restore entry point in the UI).
  app.get(
    '/coaching/clients',
    {
      schema: {
        querystring: listClientsQuerySchema,
        response: {
          200: clientHubListSchema,
        },
      },
    },
    async (request) => {
      return listClients(app.firebase.database, request.uid, app.researchConfig, {
        includeArchived: request.query.includeArchived === 'true',
      });
    },
  );

  // PATCH /api/coaching/clients/:clientId/archive — soft archive (default)
  // or restore (`{ "archived": false }`).
  app.patch(
    '/coaching/clients/:clientId/archive',
    {
      schema: {
        params: clientIdParamsSchema,
        body: archiveClientBodySchema,
        response: {
          204: z.undefined(),
          403: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        const archived = request.body?.archived ?? true;
        await archiveClient(
          app.firebase.database,
          request.uid,
          request.params.clientId,
          archived,
          app.researchConfig,
        );
        return reply.code(204).send();
      } catch (err) {
        if (err instanceof ForbiddenError) {
          return reply
            .code(403)
            .send({ error: 'Forbidden', message: err.message, statusCode: 403 });
        }
        throw err;
      }
    },
  );

  // DELETE /api/coaching/clients/:clientId — irreversible hard-delete cascade.
  app.delete(
    '/coaching/clients/:clientId',
    {
      schema: {
        params: clientIdParamsSchema,
        response: {
          204: z.undefined(),
          403: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        await deleteClient(
          app.firebase.database,
          request.uid,
          request.params.clientId,
          app.researchConfig,
        );
        return reply.code(204).send();
      } catch (err) {
        if (err instanceof ForbiddenError) {
          return reply
            .code(403)
            .send({ error: 'Forbidden', message: err.message, statusCode: 403 });
        }
        throw err;
      }
    },
  );

  // GET /api/coaching/clients/:clientId/export
  app.get(
    '/coaching/clients/:clientId/export',
    {
      schema: {
        params: clientIdParamsSchema,
        response: {
          200: clientWorkspaceExportSchema,
          403: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      // Phase 30.3 (Gate 6 corrective, defect A4): ACTOR-scoped demo
      // refusal, FIRST statement in the handler — above every read
      // `exportClient` performs. A demo/research account must not be able to
      // bulk-extract a whole workspace as a machine-readable dump, and the
      // existing research-tenant refusal inside `exportClient` keys on the
      // CLIENT, so a demo coach exporting an ORDINARY fictional client's
      // workspace passed straight through it.
      //
      // Reuses the 403 shape this route already declares and already returns
      // for a `ForbiddenError`, so no new status class or response schema is
      // introduced. The check reads only the caller's own uid, so it is not
      // an existence oracle for `:clientId`.
      if (isDemoAccountSubject(app.demoAccountConfig, request.uid)) {
        return reply.code(403).send({
          error: 'Forbidden',
          message: 'Workspace export is not available for this account',
          statusCode: 403,
        });
      }

      try {
        return await exportClient(
          app.firebase.database,
          request.uid,
          request.params.clientId,
          app.researchConfig,
        );
      } catch (err) {
        if (err instanceof ForbiddenError) {
          return reply
            .code(403)
            .send({ error: 'Forbidden', message: err.message, statusCode: 403 });
        }
        if (err instanceof NotFoundError) {
          return reply
            .code(404)
            .send({ error: 'Not Found', message: err.message, statusCode: 404 });
        }
        throw err;
      }
    },
  );

  // GET /api/coaching/clients/:clientId/kind — Phase 29 (RTEN-01, D-07,
  // review consensus finding 6): the ONE authoritative per-tenant kind
  // source the browser can trust. The hub listing (`GET /coaching/clients`)
  // excludes archived tenants by default and degrades an unresolved row to
  // an empty-metadata shape for a non-allowlisted caller, so it cannot be
  // the browser's authoritative source — this route works for an archived
  // tenant and never silently degrades.
  //
  // Written against the TOTAL `resolveTenantAccess` (never the throwing
  // `assertTenantAccess`) because this is the ONE call site in the whole
  // phase that must distinguish an unresolvable read from a denial.
  // Ordered explicitly, matching this plan's own key-shape-first criterion:
  //
  //   1. Validate `:clientId` with `isPathSafeTenantId` BEFORE any
  //      membership reference is constructed — a path-illegal id raises the
  //      existing membership rejection, never a 500.
  //   2. Check `clientMembers/{clientId}/{callerUid}` membership exactly as
  //      `requireMembership` does today. Doing membership FIRST is what
  //      keeps the server-error branch below from being an existence
  //      oracle — a non-member can never reach it.
  //   3. Branch on the four-member outcome: `ordinary`/`research` -> 200;
  //      `denied` -> the existing membership rejection, deep-equal to step
  //      2's; `indeterminate` -> a server error (never a 200, never a 403).
  //
  // This is deliberately the ONLY place the `indeterminate` outcome is
  // observable anywhere in this phase — every OTHER tenant-addressed site
  // uses the throwing `assertTenantAccess` instead.
  app.get(
    '/coaching/clients/:clientId/kind',
    {
      schema: {
        params: clientIdParamsSchema,
        response: {
          200: clientKindResponseSchema,
          403: errorResponseSchema,
        },
      },
    },
    async (request) => {
      const { clientId } = request.params;

      // Step 1: key-shape validation before any reference is constructed.
      if (!isPathSafeTenantId(clientId)) {
        throw new ForbiddenError('Not a member of this client tenant');
      }

      // Step 2: membership exactly as requireMembership does today.
      const membership = await app.firebase.database
        .ref(`clientMembers/${clientId}/${request.uid}`)
        .get();
      if (!membership.exists()) {
        throw new ForbiddenError('Not a member of this client tenant');
      }

      // Step 3: the total resolver — membership above already excludes
      // every non-member, so the `indeterminate` branch here is never an
      // existence oracle.
      const outcome = await resolveTenantAccess({
        database: app.firebase.database,
        researchConfig: app.researchConfig,
        uid: request.uid,
        tenantId: clientId,
      });

      if (outcome.kind === 'denied') {
        throw new ForbiddenError('Not a member of this client tenant');
      }
      if (outcome.kind === 'indeterminate') {
        // Deliberately NOT a ForbiddenError — an operator-facing
        // infrastructure failure, distinct from both a 200 and a 403. The
        // global error handler maps an un-typed Error to a generic 500 with
        // no message leak (apps/api/src/app.ts).
        throw new Error('Unable to resolve tenant kind');
      }

      return { kind: outcome.kind };
    },
  );
};

export default coachingTenantsRoutes;
