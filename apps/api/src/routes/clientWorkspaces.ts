import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { ownedWorkspaceListSchema } from '@smash-tracker/shared';
import { listOwnedWorkspaces } from '../claims/clientWorkspaces.js';

/**
 * `GET /api/client-workspaces` — Phase 24 (Coach Issuance & Client Claim
 * Experience, CTRL-01/CTRL-02): lists the AUTHENTICATED caller's own owned
 * workspaces. Deliberately declares no route-parameter schema and no
 * query-string schema — it accepts no tenantId, uid, clientId, or any other
 * caller-supplied identifier of any kind, which is what makes cross-uid
 * enumeration structurally impossible rather than policy-enforced (T-24-01).
 *
 * Registered unconditionally, with no `claimCode` config-null 503 gate —
 * reading one's own workspace list involves no claim code and no HMAC
 * secret, exactly like the sibling `claimDelegationsRoutes`
 * (`apps/api/src/routes/claimDelegations.ts`) on the same
 * `/client-workspaces` prefix.
 */
const clientWorkspacesRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.authenticate);

  app.get(
    '/client-workspaces',
    {
      schema: {
        response: {
          200: ownedWorkspaceListSchema,
        },
      },
    },
    async (request) => {
      return listOwnedWorkspaces(app.firebase.database, request.uid);
    },
  );
};

export default clientWorkspacesRoutes;
