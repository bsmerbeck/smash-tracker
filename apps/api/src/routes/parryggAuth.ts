import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import {
  errorResponseSchema,
  parryggLinkRecordSchema,
  parryggLoginCompleteRequestSchema,
  parryggLoginCompleteResponseSchema,
  parryggLoginSearchRequestSchema,
  parryggLoginSearchResultListSchema,
  parryggLoginStartRequestSchema,
  parryggLoginStartResponseSchema,
  type ParryggLinkRecord,
} from '@smash-tracker/shared';
import type { ParryggConfig } from '../config/env.js';
import { getUser, searchUsers, type ParryggClients } from '../parrygg/client.js';
import {
  generateVerificationCode,
  VERIFICATION_TTL_MS,
  type VerificationRecord,
} from '../parrygg/verificationCode.js';

export interface ParryggAuthRoutesOptions {
  config: ParryggConfig | null;
  /** Overridable service clients (tests) — see parrygg/client.ts. */
  clients?: ParryggClients;
}

const LOGIN_SEARCH_LIMIT = 5;

/**
 * "Log in with parry.gg" (V8-B) — public routes, no Bearer auth (there's no
 * session yet). parry.gg has no OAuth, so identity can't be proven by an
 * authenticated callback the way start.gg's login works (routes/startgg.ts,
 * `GET /auth/startgg/login` + `/callback`). Instead, the SAME bio-text
 * challenge-code trick used to verify an already-linked account (see
 * routes/parrygg.ts's `verify/start` + `verify/complete`) doubles as the
 * sole proof of ownership here:
 *
 * 1. `POST /auth/parrygg/login/search`   — gamer-tag search, up to 5 hits.
 * 2. `POST /auth/parrygg/login/start`    — issues (or resumes) an `ST-XXXXXX`
 *    code for a chosen candidate, stored at
 *    `parryggLoginVerifications/{parryUserId}` (separate keyspace from the
 *    linked-account `parryggVerifications/{uid}` — a login claim doesn't
 *    require an existing link).
 * 3. `POST /auth/parrygg/login/complete` — checks the candidate's live bio
 *    for the code. On success: if `parryggUserIndex/{parryUserId}` already
 *    maps to a uid, mint a custom token for that account (this is just
 *    "log back into my existing linked account"). Otherwise, create a new
 *    Firebase user with a deterministic uid (`parrygg-{parryUserId}` — no
 *    email available), write the link + reverse index atomically (same
 *    invariant as routes/parrygg.ts's `POST /link`), and mint a token for
 *    the new account. Either way the verification record is deleted so the
 *    code can't be replayed.
 */
const parryggAuthRoutes: FastifyPluginAsyncZod<ParryggAuthRoutesOptions> = async (app, options) => {
  const { config } = options;

  if (!config) {
    app.all('/auth/parrygg/login/*', async (_request, reply) => {
      return reply.code(503).send({
        error: 'Service Unavailable',
        message: 'parry.gg integration is not configured on this server',
        statusCode: 503,
      });
    });
    return;
  }

  const clients = options.clients;
  const loginVerificationRef = (parryUserId: string) =>
    app.firebase.database.ref(`parryggLoginVerifications/${parryUserId}`);

  async function getLoginVerification(parryUserId: string): Promise<VerificationRecord | null> {
    const snapshot = await loginVerificationRef(parryUserId).get();
    if (!snapshot.exists()) {
      return null;
    }
    return snapshot.val() as VerificationRecord;
  }

  app.post(
    '/auth/parrygg/login/search',
    {
      schema: {
        body: parryggLoginSearchRequestSchema,
        response: { 200: parryggLoginSearchResultListSchema },
      },
    },
    async (request) => {
      const results = await searchUsers(
        config.apiKey,
        request.body.query,
        LOGIN_SEARCH_LIMIT,
        clients,
      );
      return results.slice(0, LOGIN_SEARCH_LIMIT);
    },
  );

  app.post(
    '/auth/parrygg/login/start',
    {
      schema: {
        body: parryggLoginStartRequestSchema,
        response: { 200: parryggLoginStartResponseSchema, 404: errorResponseSchema },
      },
    },
    async (request, reply) => {
      const { parryUserId } = request.body;

      const user = await getUser(config.apiKey, parryUserId, clients);
      if (!user) {
        return reply.code(404).send({
          error: 'Not Found',
          message: 'No parry.gg account found with that id',
          statusCode: 404,
        });
      }

      const existing = await getLoginVerification(parryUserId);
      const verification: VerificationRecord =
        existing && existing.expiresAt > Date.now()
          ? existing
          : { code: generateVerificationCode(), expiresAt: Date.now() + VERIFICATION_TTL_MS };

      if (verification !== existing) {
        await loginVerificationRef(parryUserId).set(verification);
      }

      return {
        parryUserId,
        gamerTag: user.gamerTag,
        code: verification.code,
        expiresAt: verification.expiresAt,
      };
    },
  );

  app.post(
    '/auth/parrygg/login/complete',
    {
      schema: {
        body: parryggLoginCompleteRequestSchema,
        response: { 200: parryggLoginCompleteResponseSchema, 400: errorResponseSchema },
      },
    },
    async (request, reply) => {
      const { parryUserId } = request.body;

      const verification = await getLoginVerification(parryUserId);
      if (!verification || verification.expiresAt <= Date.now()) {
        await loginVerificationRef(parryUserId).remove();
        return reply.code(400).send({
          error: 'Bad Request',
          message: 'No login code is pending, or it has expired — start over and request a new one',
          statusCode: 400,
        });
      }

      const user = await getUser(config.apiKey, parryUserId, clients);
      if (!user || !user.bioMd.includes(verification.code)) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: `Login code not found in your parry.gg bio yet. Paste "${verification.code}" into your bio and try again.`,
          statusCode: 400,
        });
      }

      await loginVerificationRef(parryUserId).remove();

      const indexSnapshot = await app.firebase.database
        .ref(`parryggUserIndex/${parryUserId}`)
        .get();
      const existingUid = indexSnapshot.exists() ? (indexSnapshot.val() as string) : null;

      if (existingUid) {
        const token = await app.firebase.auth.createCustomToken(existingUid);
        return { token, gamerTag: user.gamerTag };
      }

      const newUid = `parrygg-${parryUserId}`;
      await app.firebase.auth.createUser({ uid: newUid });

      const record: ParryggLinkRecord = {
        parryUserId,
        gamerTag: user.gamerTag,
        verified: true,
        linkedAt: Date.now(),
        verifiedAt: Date.now(),
        ...(user.avatarUrl ? { avatarUrl: user.avatarUrl } : {}),
      };
      // Multi-path update: link + reverse index written atomically, so a
      // reader never observes one without the other (same invariant as
      // routes/parrygg.ts's POST /link).
      await app.firebase.database.ref().update({
        [`parryggLinks/${newUid}`]: parryggLinkRecordSchema.parse(record),
        [`parryggUserIndex/${parryUserId}`]: newUid,
      });

      const token = await app.firebase.auth.createCustomToken(newUid);
      return { token, gamerTag: user.gamerTag };
    },
  );
};

export default parryggAuthRoutes;
