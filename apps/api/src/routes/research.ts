import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  clientHubListSchema,
  createClientRequestSchema,
  errorResponseSchema,
  idempotencyKeySchema,
} from '@smash-tracker/shared';
import { createResearchTenant, listResearchTenants } from '../research/tenants.js';
import { grantEntitlement, revokeEntitlement } from '../research/entitlements.js';
import {
  RESEARCH_FAMILY_REJECTION,
  requireResearchAdmin,
  requireResearchTenantAdmin,
} from '../research/routeGuards.js';
import { ForbiddenError } from '../services/rtdb.js';

const createResearchTenantResponseSchema = z.object({
  tenantId: z.string().min(1),
});

const tenantParamsSchema = z.object({
  tenantId: z.string().min(1),
});

const grantEntitlementRequestSchema = z.object({
  idempotencyKey: idempotencyKeySchema,
});

const grantEntitlementResponseSchema = z.object({
  grantId: z.string().min(1),
  idempotencyKey: idempotencyKeySchema,
});

const revokeEntitlementRequestSchema = z.object({
  expectedGrantId: z.string().min(1),
});

const revokeEntitlementResponseSchema = z.object({
  ok: z.literal(true),
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

  // POST /api/research/tenants/:tenantId/entitlement/grant — plan 29-10
  // (RTEN-05A). The family's FIRST tenant-addressed routes: reuses
  // `requireResearchTenantAdmin` verbatim (never a second authorization
  // path) so a caller cannot distinguish "not an admin" from "not a
  // member" from "no such tenant" from "not a research tenant".
  //
  // Independence rules (D-04, T-29-10-03): holding this entitlement
  // confers NO administrative capability of any kind, and holding
  // administrative capability (passing this route's own guard) does NOT by
  // itself waive any charge — the entitlement is a third, structurally
  // independent authorization from the research allowlist and tenant
  // membership this guard already checks.
  app.post(
    '/research/tenants/:tenantId/entitlement/grant',
    {
      schema: {
        params: tenantParamsSchema,
        body: grantEntitlementRequestSchema,
        response: {
          200: grantEntitlementResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const rejection = await requireResearchTenantAdmin(request, request.params.tenantId);
      if (rejection) {
        return reply.code(rejection.statusCode).send(rejection.body);
      }

      try {
        const result = await grantEntitlement(
          app.firebase.database,
          request.params.tenantId,
          request.uid,
          request.body.idempotencyKey,
        );
        return reply.code(200).send(result);
      } catch (err) {
        if (err instanceof ForbiddenError) {
          // The store's own defense-in-depth "is this actually a research
          // tenant" check (see entitlements.ts's module header) — folded
          // into the SAME family rejection as the guard above, never a
          // second, distinguishable shape or status code.
          return reply
            .code(RESEARCH_FAMILY_REJECTION.statusCode)
            .send(RESEARCH_FAMILY_REJECTION.body);
        }
        throw err;
      }
    },
  );

  // POST /api/research/tenants/:tenantId/entitlement/revoke — plan 29-10
  // (RTEN-05A). Same guard, same uniform-rejection discipline as the grant
  // route above.
  app.post(
    '/research/tenants/:tenantId/entitlement/revoke',
    {
      schema: {
        params: tenantParamsSchema,
        body: revokeEntitlementRequestSchema,
        response: {
          200: revokeEntitlementResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const rejection = await requireResearchTenantAdmin(request, request.params.tenantId);
      if (rejection) {
        return reply.code(rejection.statusCode).send(rejection.body);
      }

      const result = await revokeEntitlement(
        app.firebase.database,
        request.params.tenantId,
        request.body.expectedGrantId,
      );
      return reply.code(200).send(result);
    },
  );
};

export default researchTenantsRoutes;
