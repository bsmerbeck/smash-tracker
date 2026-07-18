import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { errorResponseSchema } from '@smash-tracker/shared';
import type { Ga4Config, InternalJobsConfig } from '../config/env.js';
import { checkInternalJobSecret } from '../plugins/internalJobAuth.js';

const INTERNAL_JOBS_SECRET_HEADER = 'x-internal-jobs-secret';

export interface InternalJobsRoutesOptions {
  internalJobs: InternalJobsConfig | null;
  ga4: Ga4Config | null;
  /** Overridable fetch for the GA4 Measurement Protocol POST (tests). */
  ga4Fetch?: typeof fetch;
}

const projectGa4ResultSchema = z.object({
  projected: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
});

/**
 * Phase 10 Plan 5 (Canonical Measurement & Money Safety): the
 * Cloud-Scheduler-facing internal job routes. Root-scoped (registered
 * OUTSIDE `/api` in app.ts) so the literal path `/internal/jobs/*` matches
 * what a Cloud Scheduler HTTP target must hit — note `firebase.json`
 * currently rewrites only `/api/**` and `/s/**`, so a `/internal/**`
 * Hosting rewrite (or a direct Cloud Run URL) must be provisioned before
 * Cloud Scheduler can reach this in production (flagged for Plan 06's
 * infra-setup task; zero user-visible change either way, since these
 * routes are never on the request path a browser hits).
 *
 * T-10-05-01 (Elevation of Privilege): when `internalJobs` is null
 * (`INTERNAL_JOBS_SECRET` unset), the ENTIRE `/internal/jobs*` scope
 * answers 503 — same "absent config = 503, not an open route" convention
 * `billing.ts` already establishes for `getStripeConfig`. When configured,
 * every route below requires an exact `X-Internal-Jobs-Secret` header
 * match (constant-time compare via `checkInternalJobSecret`) or 401s.
 */
const internalJobsRoutes: FastifyPluginAsyncZod<InternalJobsRoutesOptions> = async (
  app,
  options,
) => {
  const { internalJobs } = options;

  if (!internalJobs) {
    app.all('/internal/jobs*', async (_request, reply) => {
      return reply.code(503).send({
        error: 'Service Unavailable',
        message: 'Internal jobs are not enabled on this server',
        statusCode: 503,
      });
    });
    return;
  }

  const requireInternalJobsSecret = async (request: FastifyRequest, reply: FastifyReply) => {
    const header = request.headers[INTERNAL_JOBS_SECRET_HEADER];
    const headerValue = Array.isArray(header) ? header[0] : header;
    if (!checkInternalJobSecret(headerValue, internalJobs.secret)) {
      return reply.code(401).send({
        error: 'Unauthorized',
        message: 'Missing or invalid internal jobs secret',
        statusCode: 401,
      });
    }
  };

  app.get(
    '/internal/jobs/project-ga4',
    {
      preHandler: requireInternalJobsSecret,
      schema: {
        response: {
          200: projectGa4ResultSchema,
          401: errorResponseSchema,
        },
      },
    },
    async () => {
      // Phase 10 Plan 5 Task 2 wires this to the real GA4 outbox drain
      // (jobs/projectGa4.ts's runProjectGa4) — this scaffold's own tests
      // only need to prove the 503/401/authorized-runs-handler gate.
      return { projected: 0, skipped: 0, failed: 0 };
    },
  );
};

export default internalJobsRoutes;
