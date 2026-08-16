import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { deploymentIdentitySchema, errorResponseSchema } from '@smash-tracker/shared';

/**
 * Phase 30.3 (Gate 6 capture-evidence hardening, item 3):
 * `GET /api/deployment-identity`.
 *
 * WHAT IT CLOSES. The probe-capture operator drives a refused call against a
 * DEPLOYED API and snapshots the RTDB named by its OWN local `.env`. Nothing
 * connected the two: it sealed a `databaseHost` read from the same local file
 * as the snapshot, so that value agreed with itself by construction. Point
 * the operator at an API backed by a DIFFERENT database — one with compatible
 * Firebase Auth and a compatible demo allowlist, which is exactly what a
 * staging environment is — and every check still passed while the refusal and
 * the snapshots described two different systems.
 *
 * This route lets the API state, in its own voice, which database it is
 * talking to and which build it is. The operator then refuses to seal
 * anything unless that answer matches its own environment and the revision
 * the owner reviewed.
 *
 * AUTHENTICATED, deliberately. Nothing here is secret — every member is a
 * build coordinate or a hostname already published in the web client's
 * Firebase config — so this is not a confidentiality boundary. It is a
 * least-exposure one: an unauthenticated endpoint that names the service, the
 * running revision, the release SHA, and the backing database host is a free
 * infrastructure map for anyone scanning, and it buys nothing, because the
 * only consumer (the capture operator) already carries a demo account's
 * bearer token for the identity pre-check it performs one step earlier.
 * Requiring the token it already holds costs the operator literally nothing.
 *
 * NOT restricted further than `authenticate`. There is no per-user data here
 * and no reason a signed-in user may not learn which build served them; a
 * uid allowlist would add a second allowlist to keep in sync for no gain.
 *
 * EMITS NO SECRETS. Only the members of `deploymentIdentitySchema`, which the
 * zod serializer enforces — a future field added to `DeploymentConfig` cannot
 * leak onto the wire without also being added to the shared schema.
 * `databaseHost` is a HOST, never the full `FIREBASE_DATABASE_URL`.
 */
const deploymentIdentityRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.authenticate);

  app.get(
    '/deployment-identity',
    {
      schema: {
        response: {
          200: deploymentIdentitySchema,
          503: errorResponseSchema,
        },
      },
    },
    async (_request, reply) => {
      // `index.ts` always supplies this, so a 503 here means the server was
      // constructed without an identity — an explicit "I cannot tell you who
      // I am", which the operator must treat as a hard abort rather than as
      // a coordinate it may skip.
      if (app.deploymentConfig === null) {
        return reply.code(503).send({
          error: 'Service Unavailable',
          message: 'This server was built without a deployment identity',
          statusCode: 503,
        });
      }
      return app.deploymentConfig;
    },
  );
};

export default deploymentIdentityRoutes;
