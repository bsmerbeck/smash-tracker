import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  clientHubListSchema,
  clientHubRowSchema,
  createClientRequestSchema,
  errorResponseSchema,
  fighterSelectionSchema,
  matchSchema,
  opponentAliasMapSchema,
  opponentNoteMapSchema,
  playlistSchema,
  stageFavoritesSchema,
} from '@smash-tracker/shared';
import {
  archiveClient,
  createClient,
  deleteClient,
  exportClient,
  listClients,
} from '../coaching/tenants.js';
import { ConflictError, ForbiddenError, NotFoundError } from '../services/rtdb.js';

const clientIdParamsSchema = z.object({
  clientId: z.string().min(1),
});

const archiveClientBodySchema = z.object({ archived: z.boolean() }).nullish();

const listClientsQuerySchema = z.object({
  /** `?includeArchived=true` also returns soft-archived rows (TEN-06 restore path). */
  includeArchived: z.enum(['true', 'false']).optional(),
});

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
      return listClients(app.firebase.database, request.uid, {
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
        await archiveClient(app.firebase.database, request.uid, request.params.clientId, archived);
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
        await deleteClient(app.firebase.database, request.uid, request.params.clientId);
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
      try {
        return await exportClient(app.firebase.database, request.uid, request.params.clientId);
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
};

export default coachingTenantsRoutes;
