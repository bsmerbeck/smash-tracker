import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  createGroupRequestSchema,
  errorResponseSchema,
  groupLeaderboardSchema,
  groupListSchema,
  groupRecordSchema,
  joinGroupRequestSchema,
} from '@smash-tracker/shared';
import {
  ConflictError,
  createGroup,
  deleteGroup,
  ForbiddenError,
  getGroupLeaderboard,
  GroupLeaderboardCache,
  joinGroup,
  leaveGroup,
  listGroups,
  NotFoundError,
  requireMember,
} from '../groups/groups.js';

const groupIdParamsSchema = z.object({
  id: z.string().min(1),
});

/**
 * /api/groups — V7-D friend-group Glicko-2 leaderboards, the app's FIRST
 * multi-tenant feature (data visible between users). See
 * `packages/shared/src/groups.ts` for the RTDB layout and the strict
 * "what's exposed" contract (`leaderboardEntrySchema`), and
 * `apps/api/src/groups/groups.ts` for the write/read logic this route
 * delegates to.
 *
 * Every route requires sign-in; the leaderboard route additionally 403s for
 * non-members. A single `GroupLeaderboardCache` instance is shared across
 * requests to this plugin instance (~5 min TTL) so repeated leaderboard
 * views don't recompute every member's full Glicko history from scratch.
 */
const groupsRoutes: FastifyPluginAsyncZod = async (app) => {
  const cache = new GroupLeaderboardCache();

  app.addHook('preHandler', app.authenticate);

  // POST /api/groups
  app.post(
    '/groups',
    {
      schema: {
        body: createGroupRequestSchema,
        response: {
          200: groupRecordSchema,
          403: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        return await createGroup(app.firebase.database, request.uid, request.body.name);
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

  // POST /api/groups/join
  app.post(
    '/groups/join',
    {
      schema: {
        body: joinGroupRequestSchema,
        response: {
          200: groupRecordSchema,
          403: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        const group = await joinGroup(app.firebase.database, request.uid, request.body.code);
        cache.invalidate(group.id);
        return group;
      } catch (err) {
        if (err instanceof NotFoundError) {
          return reply
            .code(404)
            .send({ error: 'Not Found', message: err.message, statusCode: 404 });
        }
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

  // GET /api/groups
  app.get(
    '/groups',
    {
      schema: {
        response: {
          200: groupListSchema,
        },
      },
    },
    async (request) => {
      return listGroups(app.firebase.database, request.uid);
    },
  );

  // GET /api/groups/:id/leaderboard
  app.get(
    '/groups/:id/leaderboard',
    {
      schema: {
        params: groupIdParamsSchema,
        response: {
          200: groupLeaderboardSchema,
          403: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        await requireMember(app.firebase.database, request.uid, request.params.id);
        return await getGroupLeaderboard(
          app.firebase.database,
          cache,
          request.uid,
          request.params.id,
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

  // POST /api/groups/:id/leave
  app.post(
    '/groups/:id/leave',
    {
      schema: {
        params: groupIdParamsSchema,
        response: {
          204: z.undefined(),
          404: errorResponseSchema,
          409: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        await leaveGroup(app.firebase.database, request.uid, request.params.id);
        cache.invalidate(request.params.id);
        return reply.code(204).send();
      } catch (err) {
        if (err instanceof NotFoundError) {
          return reply
            .code(404)
            .send({ error: 'Not Found', message: err.message, statusCode: 404 });
        }
        if (err instanceof ConflictError) {
          return reply.code(409).send({ error: 'Conflict', message: err.message, statusCode: 409 });
        }
        throw err;
      }
    },
  );

  // DELETE /api/groups/:id
  app.delete(
    '/groups/:id',
    {
      schema: {
        params: groupIdParamsSchema,
        response: {
          204: z.undefined(),
          403: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        await deleteGroup(app.firebase.database, request.uid, request.params.id);
        cache.invalidate(request.params.id);
        return reply.code(204).send();
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

export default groupsRoutes;
