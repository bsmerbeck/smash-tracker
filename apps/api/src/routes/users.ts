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

  // PUT /api/users/me — idempotent upsert. Replaces the legacy `createProfile`
  // Cloud Function (auth onCreate trigger writing `users/{uid} = { email }`),
  // deleted from the smash-tracker-f97b7 project on 2026-07-08. The user node
  // is now created only when the client calls this endpoint.
  //
  // Phase 7 (Recap Cards & Share-Loop Analytics): accepts an optional
  // `referredByShareId` body (FUNNEL-02) — the client reads its localStorage
  // share-referral stamp and passes it through on every provisioning call
  // (not just signup). The stamped value is the share-page route TOKEN (the
  // public snapshot never exposes a shareId); `RtdbService.upsertUser`
  // resolves it via `shareTokens/{token}` to the durable shareId before
  // storing (review CR-01) — an unresolvable token is silently dropped —
  // and applies write-once, first-touch semantics, so a returning user's
  // stale stamp can never overwrite an existing attribution.
  app.put(
    '/users/me',
    {
      schema: {
        // `.nullish()`, not just `.optional()`: Fastify sets `request.body`
        // to `null` (not `undefined`) for a bodyless request with no
        // Content-Type header — the shape every pre-Phase-7 client sends.
        // `.max(128)` (review WR-02): a real stamped value is a 43-char
        // base64url share token (SHARE_TOKEN_SHAPE allows up to 128), so an
        // unbounded blob is rejected at the boundary before it can reach the
        // token lookup or round-trip through RTDB. Charset validation happens
        // in `upsertUser` (non-conforming values are silently dropped, never
        // an error — provisioning must not fail on a bad referral).
        body: z.object({ referredByShareId: z.string().max(128).optional() }).nullish(),
        response: {
          200: z.object({ uid: z.string(), email: z.string().email() }),
        },
      },
    },
    async (request) => {
      const email = request.userEmail;
      await rtdb.upsertUser(request.uid, {
        email,
        // Wire name is `referredByShareId` for client back-compat, but the
        // VALUE is the share-page bearer token — upsertUser resolves it.
        referralToken: request.body?.referredByShareId,
      });
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
