import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import {
  errorResponseSchema,
  startggAuthorizeResponseSchema,
  startggLinkRecordSchema,
  startggStatusSchema,
  startggSyncSummarySchema,
  type StartggLinkRecord,
} from '@smash-tracker/shared';
import type { StartggConfig } from '../config/env.js';
import { buildAuthorizeUrl, exchangeCode, signState, verifyState } from '../startgg/oauth.js';
import { fetchCurrentUser } from '../startgg/client.js';
import { importPlayerMatches } from '../startgg/sync.js';

export interface StartggRoutesOptions {
  config: StartggConfig | null;
  /** Overridable fetch for OAuth/GraphQL calls (tests). */
  fetchImpl?: typeof fetch;
}

/**
 * start.gg integration:
 * - authenticated management routes under /integrations/startgg
 *   (status/authorize/sync/unlink)
 * - public OAuth endpoints: GET /integrations/startgg/callback (both flows,
 *   distinguished by the HMAC-signed state) and GET /auth/startgg/login
 *   (starts the login flow — no session yet, so it can't be authenticated)
 *
 * "Login with start.gg" works by exchanging the OAuth code, reading the
 * verified identity (scopes user.identity + user.email), finding-or-creating
 * the Firebase user by email, and handing the SPA a Firebase custom token in
 * the redirect fragment; the SPA finishes with signInWithCustomToken.
 */
const startggRoutes: FastifyPluginAsyncZod<StartggRoutesOptions> = async (app, options) => {
  const { config } = options;

  if (!config) {
    // Not configured: keep the surface discoverable but explicit.
    app.all('/integrations/startgg/*', async (_request, reply) => {
      return reply.code(503).send({
        error: 'Service Unavailable',
        message: 'start.gg integration is not configured on this server',
        statusCode: 503,
      });
    });
    app.get('/auth/startgg/login', async (_request, reply) => {
      return reply.code(503).send({
        error: 'Service Unavailable',
        message: 'start.gg integration is not configured on this server',
        statusCode: 503,
      });
    });
    return;
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const oauthConfig = {
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    redirectUri: config.redirectUri,
    stateSecret: config.stateSecret,
  };

  const linksRef = (uid: string) => app.firebase.database.ref(`startggLinks/${uid}`);

  async function getLink(uid: string): Promise<StartggLinkRecord | null> {
    const snapshot = await linksRef(uid).get();
    if (!snapshot.exists()) {
      return null;
    }
    return startggLinkRecordSchema.parse(snapshot.val());
  }

  // ---- authenticated management routes ---------------------------------

  app.get(
    '/integrations/startgg/status',
    { preHandler: app.authenticate, schema: { response: { 200: startggStatusSchema } } },
    async (request) => {
      const link = await getLink(request.uid);
      if (!link) {
        return { linked: false };
      }
      return {
        linked: true,
        gamerTag: link.gamerTag,
        playerId: link.playerId,
        slug: link.slug,
        ...(link.lastSyncAt !== undefined ? { lastSyncAt: link.lastSyncAt } : {}),
      };
    },
  );

  app.get(
    '/integrations/startgg/authorize',
    { preHandler: app.authenticate, schema: { response: { 200: startggAuthorizeResponseSchema } } },
    async (request) => {
      const state = signState(config.stateSecret, 'link', request.uid);
      return { url: buildAuthorizeUrl(oauthConfig, state) };
    },
  );

  app.post(
    '/integrations/startgg/sync',
    {
      preHandler: app.authenticate,
      schema: { response: { 200: startggSyncSummarySchema, 409: errorResponseSchema } },
    },
    async (request, reply) => {
      const link = await getLink(request.uid);
      if (!link) {
        return reply.code(409).send({
          error: 'Conflict',
          message: 'No start.gg account is linked',
          statusCode: 409,
        });
      }
      return importPlayerMatches(
        app.firebase.database,
        request.uid,
        link.playerId,
        config.apiToken,
        fetchImpl,
        request.log,
      );
    },
  );

  app.delete(
    '/integrations/startgg/link',
    { preHandler: app.authenticate, schema: { response: { 204: z.null() } } },
    async (request, reply) => {
      await linksRef(request.uid).remove();
      return reply.code(204).send(null);
    },
  );

  // ---- public OAuth endpoints -------------------------------------------

  app.get('/auth/startgg/login', async (_request, reply) => {
    const state = signState(config.stateSecret, 'login');
    return reply.redirect(buildAuthorizeUrl(oauthConfig, state));
  });

  app.get(
    '/integrations/startgg/callback',
    {
      schema: {
        querystring: z.object({
          code: z.string().optional(),
          state: z.string().optional(),
          error: z.string().optional(),
        }),
      },
    },
    async (request, reply) => {
      const { code, state, error } = request.query;
      const failure = (reason: string) =>
        reply.redirect(`${config.webBaseUrl}/?startgg=error&reason=${encodeURIComponent(reason)}`);

      if (error) {
        return failure(error);
      }
      if (!code || !state) {
        return failure('missing_code_or_state');
      }
      const payload = verifyState(config.stateSecret, state);
      if (!payload) {
        return failure('invalid_state');
      }

      let identity;
      try {
        const tokens = await exchangeCode(oauthConfig, code, fetchImpl);
        identity = await fetchCurrentUser(tokens.access_token, fetchImpl);
      } catch (err) {
        request.log.error({ err }, 'start.gg OAuth exchange failed');
        return failure('exchange_failed');
      }

      if (payload.m === 'link') {
        const uid = payload.u;
        if (!uid) {
          return failure('invalid_state');
        }
        const record: StartggLinkRecord = {
          userId: identity.id,
          playerId: identity.player.id,
          gamerTag: identity.player.gamerTag,
          slug: identity.slug,
          linkedAt: Date.now(),
        };
        await linksRef(uid).update(record);
        return reply.redirect(`${config.webBaseUrl}/settings/integrations?startgg=linked`);
      }

      // Login flow: find-or-create the Firebase user by verified email.
      const email = identity.email;
      if (!email) {
        return failure('email_unavailable');
      }
      // Everything past the code exchange must degrade to the same
      // redirect-with-reason as the other failure paths: a raw 500 here makes
      // Firebase Hosting's proxy retry the callback, and the retry burns the
      // single-use OAuth code on an attempt the user never sees (observed
      // live when createCustomToken lacked iam.serviceAccounts.signBlob).
      try {
        let firebaseUser;
        try {
          firebaseUser = await app.firebase.auth.getUserByEmail(email);
        } catch {
          firebaseUser = await app.firebase.auth.createUser({ email });
        }
        const customToken = await app.firebase.auth.createCustomToken(firebaseUser.uid);
        // Also persist the link for the newly signed-in account so sync works
        // immediately after a "login with start.gg".
        const record: StartggLinkRecord = {
          userId: identity.id,
          playerId: identity.player.id,
          gamerTag: identity.player.gamerTag,
          slug: identity.slug,
          linkedAt: Date.now(),
        };
        await linksRef(firebaseUser.uid).update(record);
        // Token travels in the URL fragment: fragments never reach servers/logs.
        return reply.redirect(
          `${config.webBaseUrl}/auth/startgg#token=${encodeURIComponent(customToken)}`,
        );
      } catch (err) {
        request.log.error({ err }, 'start.gg login completion failed');
        return failure('login_failed');
      }
    },
  );
};

export default startggRoutes;
