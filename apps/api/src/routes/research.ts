import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  clientHubListSchema,
  createClientRequestSchema,
  errorResponseSchema,
} from '@smash-tracker/shared';
import { createResearchTenant, listResearchTenants } from '../research/tenants.js';
import { requireResearchAdmin } from '../research/routeGuards.js';

const createResearchTenantResponseSchema = z.object({
  tenantId: z.string().min(1),
});

/**
 * `/api/research/tenants` — Phase 29 (Research Tenancy, Isolation &
 * Governance Gate, RTEN-01): the admin-only research tenant collection
 * routes — creation and per-admin listing. This is the TENANT half of the
 * family; plan 29-10 extends this SAME file with the entitlement routes,
 * reusing `requireResearchTenantAdmin` (the tenant-addressed guard) rather
 * than re-deriving it.
 *
 * Registered UNCONDITIONALLY in `apps/api/src/app.ts` — no config-null 503
 * gate at registration time, because route PRESENCE itself must leak
 * nothing. The config-null check lives inside each handler via
 * `requireResearchAdmin` instead, so a null-config deployment answers the
 * family's uniform rejection identically to a configured deployment facing
 * a non-allowlisted caller.
 *
 * `app.addHook('preHandler', app.authenticate)` runs BEFORE every other
 * check, so an unauthenticated caller is rejected by the authentication
 * boundary's OWN distinguishable failure — never the family's uniform
 * rejection (R-11-1, review finding 29-11 HIGH). Deliberately does NOT opt
 * into `app.resolveSubject` — these are admin-scoped routes over the
 * caller's OWN index (`request.uid` directly), not same-subject content
 * routes gated by the `X-Active-Subject` header.
 */
const researchTenantsRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.authenticate);

  // POST /api/research/tenants
  app.post(
    '/research/tenants',
    {
      schema: {
        body: createClientRequestSchema,
        response: {
          201: createResearchTenantResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const rejection = requireResearchAdmin(request);
      if (rejection) {
        return reply.code(rejection.statusCode).send(rejection.body);
      }

      const { tenantId } = await createResearchTenant(
        app.firebase.database,
        request.uid,
        request.body.label,
      );
      return reply.code(201).send({ tenantId });
    },
  );

  // GET /api/research/tenants — declares no route parameter and no
  // querystring, mirroring `clientWorkspaces.ts`'s enumeration-proof
  // posture: it accepts no tenantId/uid/clientId of any kind, so
  // cross-uid enumeration is structurally impossible, not merely
  // policy-enforced.
  app.get(
    '/research/tenants',
    {
      schema: {
        response: {
          200: clientHubListSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const rejection = requireResearchAdmin(request);
      if (rejection) {
        return reply.code(rejection.statusCode).send(rejection.body);
      }

      return listResearchTenants(app.firebase.database, request.uid);
    },
  );
};

export default researchTenantsRoutes;
