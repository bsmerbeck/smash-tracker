import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { SubjectKindResolution } from '@smash-tracker/shared';
import { resolveSubject } from '../coaching/subject.js';

declare module 'fastify' {
  interface FastifyInstance {
    resolveSubject: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
  interface FastifyRequest {
    subjectId: string;
    /**
     * Phase 29 (Research Tenancy, Isolation & Governance Gate, D-07): the
     * server-resolved tenant-kind resolution, populated by THIS SAME
     * preHandler alongside `subjectId`. NEVER derived from a header, body,
     * or query parameter — it is read from the tenant record via
     * `apps/api/src/research/access.ts`'s `assertTenantAccess`, which is
     * also the research authorization gate for every header-driven subject
     * route.
     *
     * Population invariant (cycle-2 finding C2-MED-8): `undefined` means
     * EXACTLY ONE thing — this preHandler ran and the subject is personal.
     * It is assigned UNCONDITIONALLY (explicitly `undefined` for the
     * personal case, never left as an absent property), so it must NEVER
     * also be read as "this route never opted into subject resolution".
     * Any handler reading `request.subjectKind` MUST be registered under
     * this preHandler — plan 29-07's emitter audit carries the structural
     * assertion that enforces this across the codebase.
     */
    subjectKind: SubjectKindResolution | undefined;
  }
}

/**
 * Decorates the app with a `resolveSubject` preHandler that turns a verified
 * `request.uid` (from `app.authenticate`, which MUST run first) plus the
 * `X-Active-Subject` header into `request.subjectId` — the single id every
 * same-subject route call site uses in place of `request.uid` from now on
 * — and, as of Phase 29, `request.subjectKind` alongside it (see the
 * `declare module 'fastify'` block above for the population invariant).
 *
 * Opted into PER ROUTE FILE (`app.addHook('preHandler', app.resolveSubject)`
 * directly beneath the existing `app.addHook('preHandler', app.authenticate)`
 * line), never registered globally at the `/api` scope — personal-only
 * routes (billing, gspSettings, reports, integrations, `/users/me`, etc.)
 * never opt in, so they can never be pointed at a tenant (PAR-04).
 *
 * See `apps/api/src/coaching/subject.ts` for the actual resolution logic
 * (kept separate from the Fastify decorator so it's unit-testable without
 * spinning up an app).
 */
export default fp(async function resolveSubjectPlugin(app: FastifyInstance) {
  app.decorate('resolveSubject', async (request: FastifyRequest) => {
    const header = request.headers['x-active-subject'];
    const value = Array.isArray(header) ? header[0] : header;

    const resolved = await resolveSubject({
      database: app.firebase.database,
      uid: request.uid,
      header: value,
      researchConfig: app.researchConfig,
    });

    request.subjectId = resolved.subjectId;
    request.subjectKind = resolved.subjectKind;
  });
});
