import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import {
  fighterSelectionInputSchema,
  fighterSelectionSchema,
  userProfileSchema,
} from '@smash-tracker/shared';
import { z } from 'zod';
import { NotFoundError, RtdbService } from '../services/rtdb.js';

const usersRoutes: FastifyPluginAsyncZod = async (app) => {
  const rtdb = new RtdbService(app.firebase.database);

  app.addHook('preHandler', app.authenticate);

  // PUT /api/users/me — idempotent upsert, replaces the deleted Cloud
  // Function's onCreate auth trigger (`users/{uid} = { email }`).
  app.put(
    '/users/me',
    {
      schema: {
        response: {
          200: z.object({ uid: z.string(), email: z.string().email() }),
        },
      },
    },
    async (request) => {
      const email = request.userEmail;
      await rtdb.upsertUser(request.uid, { email });
      return { uid: request.uid, email };
    },
  );

  // GET /api/users/me — user node + fighter selections.
  app.get(
    '/users/me',
    {
      schema: {
        response: {
          200: userProfileSchema,
        },
      },
    },
    async (request) => {
      const [user, fighters] = await Promise.all([
        rtdb.getUser(request.uid),
        rtdb.getFighterSelection(request.uid),
      ]);

      if (!user) {
        throw new NotFoundError('User profile not found. Call PUT /api/users/me first.');
      }

      return {
        uid: request.uid,
        email: user.email,
        fighters,
      };
    },
  );

  // GET /api/users/me/fighters
  app.get(
    '/users/me/fighters',
    {
      schema: {
        response: {
          200: fighterSelectionSchema,
        },
      },
    },
    async (request) => {
      return rtdb.getFighterSelection(request.uid);
    },
  );

  // PUT /api/users/me/fighters
  app.put(
    '/users/me/fighters',
    {
      schema: {
        body: fighterSelectionInputSchema,
        response: {
          200: fighterSelectionSchema,
        },
      },
    },
    async (request) => {
      await rtdb.setFighterSelection(request.uid, request.body);
      return request.body;
    },
  );
};

export default usersRoutes;
