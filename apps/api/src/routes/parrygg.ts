import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import {
  errorResponseSchema,
  parryggLinkRecordSchema,
  parryggLinkRequestSchema,
  parryggSearchResultListSchema,
  parryggStatusSchema,
  parryggSyncSummarySchema,
  parryggVerificationCompleteResponseSchema,
  parryggVerificationStartResponseSchema,
  type ParryggLinkRecord,
} from '@smash-tracker/shared';
import type { ParryggConfig } from '../config/env.js';
import { getUser, searchUsers, type ParryggClients } from '../parrygg/client.js';
import { importParryggMatches } from '../parrygg/sync.js';
import {
  generateVerificationCode,
  VERIFICATION_TTL_MS,
  type VerificationRecord,
} from '../parrygg/verificationCode.js';

export interface ParryggRoutesOptions {
  config: ParryggConfig | null;
  /** Overridable service clients (tests) — see parrygg/client.ts. */
  clients?: ParryggClients;
}

/**
 * parry.gg integration (V8-A): a second tournament-site integration
 * alongside start.gg (routes/startgg.ts). Structural differences from
 * start.gg, both driven by parry.gg having no OAuth:
 *
 * - Linking is identity-search + explicit "link" call, not an OAuth
 *   redirect — the user finds their own parry.gg account by gamer tag and
 *   confirms it (POST .../link), rather than authorizing an app.
 * - Because there's no OAuth grant proving account ownership, a separate
 *   verification step (bio-text challenge code) exists so a user can't
 *   silently claim someone else's public parry.gg profile as their own.
 *   Verification is NOT required to sync — syncing a linked account reads
 *   the SAME public match data start.gg's sync reads with its own server
 *   token, so the trust bar is "you found the right profile", proven by
 *   `POST /link`'s reverse-index uniqueness check, not "you proved you own
 *   it". Verification exists for surfacing a check mark, not for gating
 *   sync — see the PR body for the full rationale.
 */
const parryggRoutes: FastifyPluginAsyncZod<ParryggRoutesOptions> = async (app, options) => {
  const { config } = options;

  if (!config) {
    app.all('/integrations/parrygg/*', async (_request, reply) => {
      return reply.code(503).send({
        error: 'Service Unavailable',
        message: 'parry.gg integration is not configured on this server',
        statusCode: 503,
      });
    });
    return;
  }

  const clients = options.clients;
  const linksRef = (uid: string) => app.firebase.database.ref(`parryggLinks/${uid}`);
  const indexRef = (parryUserId: string) =>
    app.firebase.database.ref(`parryggUserIndex/${parryUserId}`);
  const verificationRef = (uid: string) => app.firebase.database.ref(`parryggVerifications/${uid}`);

  async function getLink(uid: string): Promise<ParryggLinkRecord | null> {
    const snapshot = await linksRef(uid).get();
    if (!snapshot.exists()) {
      return null;
    }
    return parryggLinkRecordSchema.parse(snapshot.val());
  }

  async function getVerification(uid: string): Promise<VerificationRecord | null> {
    const snapshot = await verificationRef(uid).get();
    if (!snapshot.exists()) {
      return null;
    }
    return snapshot.val() as VerificationRecord;
  }

  app.get(
    '/integrations/parrygg/status',
    { preHandler: app.authenticate, schema: { response: { 200: parryggStatusSchema } } },
    async (request) => {
      const link = await getLink(request.uid);
      if (!link) {
        return { linked: false };
      }
      const verification = link.verified ? null : await getVerification(request.uid);
      return {
        linked: true,
        gamerTag: link.gamerTag,
        parryUserId: link.parryUserId,
        verified: link.verified,
        ...(link.avatarUrl ? { avatarUrl: link.avatarUrl } : {}),
        ...(link.lastSyncAt !== undefined ? { lastSyncAt: link.lastSyncAt } : {}),
        ...(verification && verification.expiresAt > Date.now()
          ? { verificationPending: true }
          : {}),
      };
    },
  );

  app.get(
    '/integrations/parrygg/search',
    {
      preHandler: app.authenticate,
      schema: {
        querystring: z.object({ tag: z.string().min(1) }),
        response: { 200: parryggSearchResultListSchema },
      },
    },
    async (request) => {
      return searchUsers(config.apiKey, request.query.tag, 10, clients);
    },
  );

  app.post(
    '/integrations/parrygg/link',
    {
      preHandler: app.authenticate,
      schema: {
        body: parryggLinkRequestSchema,
        response: { 200: parryggStatusSchema, 404: errorResponseSchema, 409: errorResponseSchema },
      },
    },
    async (request, reply) => {
      const { parryUserId } = request.body;

      const existingOwner = await indexRef(parryUserId).get();
      if (existingOwner.exists() && existingOwner.val() !== request.uid) {
        return reply.code(409).send({
          error: 'Conflict',
          message: 'This parry.gg account is already linked to a different smash-tracker account',
          statusCode: 409,
        });
      }

      const user = await getUser(config.apiKey, parryUserId, clients);
      if (!user) {
        return reply.code(404).send({
          error: 'Not Found',
          message: 'No parry.gg account found with that id',
          statusCode: 404,
        });
      }

      const record: ParryggLinkRecord = {
        parryUserId,
        gamerTag: user.gamerTag,
        verified: false,
        linkedAt: Date.now(),
        ...(user.avatarUrl ? { avatarUrl: user.avatarUrl } : {}),
      };
      // Multi-path update: link + reverse index written atomically, so a
      // reader never observes one without the other.
      await app.firebase.database.ref().update({
        [`parryggLinks/${request.uid}`]: record,
        [`parryggUserIndex/${parryUserId}`]: request.uid,
      });

      return {
        linked: true,
        gamerTag: record.gamerTag,
        parryUserId: record.parryUserId,
        verified: false,
        ...(record.avatarUrl ? { avatarUrl: record.avatarUrl } : {}),
      };
    },
  );

  app.post(
    '/integrations/parrygg/unlink',
    { preHandler: app.authenticate, schema: { response: { 204: z.null() } } },
    async (request, reply) => {
      const link = await getLink(request.uid);
      const updates: Record<string, null> = {
        [`parryggLinks/${request.uid}`]: null,
        [`parryggVerifications/${request.uid}`]: null,
      };
      if (link) {
        updates[`parryggUserIndex/${link.parryUserId}`] = null;
      }
      await app.firebase.database.ref().update(updates);
      return reply.code(204).send(null);
    },
  );

  app.post(
    '/integrations/parrygg/verify/start',
    {
      preHandler: app.authenticate,
      schema: {
        response: { 200: parryggVerificationStartResponseSchema, 409: errorResponseSchema },
      },
    },
    async (request, reply) => {
      const link = await getLink(request.uid);
      if (!link) {
        return reply.code(409).send({
          error: 'Conflict',
          message: 'No parry.gg account is linked',
          statusCode: 409,
        });
      }

      const existing = await getVerification(request.uid);
      if (existing && existing.expiresAt > Date.now()) {
        return existing;
      }

      const verification: VerificationRecord = {
        code: generateVerificationCode(),
        expiresAt: Date.now() + VERIFICATION_TTL_MS,
      };
      await verificationRef(request.uid).set(verification);
      return verification;
    },
  );

  app.post(
    '/integrations/parrygg/verify/complete',
    {
      preHandler: app.authenticate,
      schema: {
        response: {
          200: parryggVerificationCompleteResponseSchema,
          400: errorResponseSchema,
          409: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const link = await getLink(request.uid);
      if (!link) {
        return reply.code(409).send({
          error: 'Conflict',
          message: 'No parry.gg account is linked',
          statusCode: 409,
        });
      }

      const verification = await getVerification(request.uid);
      if (!verification || verification.expiresAt <= Date.now()) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: 'No verification code is pending, or it has expired — start verification again',
          statusCode: 400,
        });
      }

      const user = await getUser(config.apiKey, link.parryUserId, clients);
      if (!user || !user.bioMd.includes(verification.code)) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: `Verification code not found in your parry.gg bio yet. Paste "${verification.code}" into your bio and try again.`,
          statusCode: 400,
        });
      }

      const verifiedAt = Date.now();
      await app.firebase.database.ref().update({
        [`parryggLinks/${request.uid}/verified`]: true,
        [`parryggLinks/${request.uid}/verifiedAt`]: verifiedAt,
        [`parryggVerifications/${request.uid}`]: null,
      });

      return { verified: true, verifiedAt } as const;
    },
  );

  app.post(
    '/integrations/parrygg/sync',
    {
      preHandler: app.authenticate,
      schema: { response: { 200: parryggSyncSummarySchema, 409: errorResponseSchema } },
    },
    async (request, reply) => {
      const link = await getLink(request.uid);
      if (!link) {
        return reply.code(409).send({
          error: 'Conflict',
          message: 'No parry.gg account is linked',
          statusCode: 409,
        });
      }
      // Sync is always user-initiated (this route), never scheduled/background.
      return importParryggMatches(
        app.firebase.database,
        request.uid,
        link.parryUserId,
        config.apiKey,
        clients,
      );
    },
  );
};

export default parryggRoutes;
