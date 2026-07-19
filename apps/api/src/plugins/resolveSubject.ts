import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { resolveSubjectId } from '../coaching/subject.js';

declare module 'fastify' {
  interface FastifyInstance {
    resolveSubject: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
  interface FastifyRequest {
    subjectId: string;
  }
}

/**
 * Decorates the app with a `resolveSubject` preHandler that turns a verified
 * `request.uid` (from `app.authenticate`, which MUST run first) plus the
 * `X-Active-Subject` header into `request.subjectId` — the single id every
 * same-subject route call site uses in place of `request.uid` from now on.
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

    request.subjectId = await resolveSubjectId({
      database: app.firebase.database,
      uid: request.uid,
      header: value,
    });
  });
});
