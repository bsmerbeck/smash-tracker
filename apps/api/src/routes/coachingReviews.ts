import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  clientVisibleVersionSchema,
  createDraftPatchInputSchema,
  errorResponseSchema,
  reviewDraftSchema,
  REVIEW_DELIVERY_STATES,
  REVIEW_SECTION_KINDS,
} from '@smash-tracker/shared';
import { buildDomainEnvelope } from '../events/envelope.js';
import { createEvent } from '../events/ledger.js';
import { requireMembership } from '../coaching/tenants.js';
import {
  addSection,
  archiveReview,
  autosaveDraft,
  DEFAULT_REVIEW_SECTIONS,
  DraftConflictError,
  getDraft,
  listReviews,
  previewClientVersion,
  publishReview,
  REVIEW_STATUSES,
  setSectionHidden,
} from '../coaching/reviews.js';

const clientIdParamsSchema = z.object({ clientId: z.string().min(1) });
const reviewIdParamsSchema = z.object({
  clientId: z.string().min(1),
  reviewId: z.string().min(1),
});
const sectionParamsSchema = z.object({
  clientId: z.string().min(1),
  reviewId: z.string().min(1),
  sectionId: z.string().min(1),
});

const reviewCreatedResponseSchema = z.object({
  reviewId: z.string().min(1),
  revision: z.number().int().positive(),
});

const reviewListItemResponseSchema = z.object({
  reviewId: z.string().min(1),
  status: z.enum(REVIEW_STATUSES),
  latestVersion: z.number().int().positive().nullable(),
  revision: z.number().int().nonnegative(),
  deliveryState: z.enum(REVIEW_DELIVERY_STATES).nullable(),
  createdAt: z.number().int().nonnegative(),
  lastAutosavedAt: z.number().int().nonnegative(),
});

const draftConflictResponseSchema = z.object({
  error: z.string(),
  message: z.string(),
  statusCode: z.literal(409),
  serverDraft: reviewDraftSchema,
});

const publishResultSchema = z.object({ version: z.number().int().positive() });

// Publish is server-authoritative (D-06/T-12-06): the body carries no
// content field of any kind — Zod's default object mode strips any
// unrecognized key (e.g. a client-supplied `sections`) silently, so it
// never reaches the handler even if a malicious/buggy client sends one.
const publishBodySchema = z.object({}).nullish();

const addSectionBodySchema = z.object({
  kind: z.enum(REVIEW_SECTION_KINDS),
  title: z.string().trim().max(60).nullish(),
});

/** `X-Session-Id` header, mirroring `coachingTenants.ts`'s `createClient` call site — defaults to `'unknown'` when absent (never blocks the request). */
function sessionIdFromHeader(request: FastifyRequest): string {
  const header = request.headers['x-session-id'];
  const value = Array.isArray(header) ? header[0] : header;
  return value ?? 'unknown';
}

/**
 * Phase 12 (Coach Reviews & Delivery, REV-01/02/05/06/07, DLV-04): the
 * coach-side review-authoring routes, nested under
 * `/api/coaching/clients/:clientId/reviews`. Gated by a direct
 * `requireMembership` check on the URL's `:clientId` — the SAME pattern
 * `coachingTenants.ts`'s own `/coaching/clients/:clientId/*` routes already
 * use (no-oracle 403 for a foreign/nonexistent tenant alike), NOT the
 * `X-Active-Subject` header/`app.resolveSubject` mechanism that flat routes
 * like `/api/matches` use — see `requireMembership`'s doc comment.
 *
 * `NotFoundError`/`ConflictError`/`ForbiddenError` thrown by the service
 * layer bubble to the global error handler (`app.ts`) for the standard
 * 404/409/403 mapping; only `DraftConflictError` needs a local catch, since
 * its 409 body carries the extra `serverDraft` field the generic handler
 * can't know about.
 */
const coachingReviewsRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.authenticate);
  app.addHook('preHandler', async (request) => {
    const { clientId } = request.params as { clientId?: string };
    if (clientId) {
      await requireMembership(app.firebase.database, request.uid, clientId);
    }
  });

  // GET /api/coaching/clients/:clientId/reviews — the two independent
  // state machines (D-05) side by side: review status + delivery summary.
  app.get(
    '/coaching/clients/:clientId/reviews',
    {
      schema: {
        params: clientIdParamsSchema,
        response: { 200: z.array(reviewListItemResponseSchema) },
      },
    },
    async (request) => listReviews(app.firebase.database, request.params.clientId),
  );

  // POST /api/coaching/clients/:clientId/reviews — start a new review. The
  // first draft is constructed via autosaveDraft's null-first-run branch
  // (CR-01) — that RTDB write IS the durable transition
  // coach_review_draft_started fires after (D-11).
  app.post(
    '/coaching/clients/:clientId/reviews',
    {
      schema: {
        params: clientIdParamsSchema,
        response: { 201: reviewCreatedResponseSchema },
      },
    },
    async (request, reply) => {
      const reviewId = randomUUID();
      const { revision } = await autosaveDraft(
        app.firebase.database,
        request.params.clientId,
        reviewId,
        { sections: DEFAULT_REVIEW_SECTIONS, coachPrivateNotes: null },
        0,
      );

      void createEvent(
        app.firebase.database,
        buildDomainEnvelope({
          eventName: 'coach_review_draft_started',
          actorId: request.uid,
          sessionId: sessionIdFromHeader(request),
          causationId: reviewId,
          consentState: 'unknown',
        }),
      );

      return reply.code(201).send({ reviewId, revision });
    },
  );

  // GET /api/coaching/clients/:clientId/reviews/:reviewId/draft — the ONLY
  // endpoint that returns `coachPrivateNotes` (coach-facing only).
  app.get(
    '/coaching/clients/:clientId/reviews/:reviewId/draft',
    {
      schema: {
        params: reviewIdParamsSchema,
        response: { 200: reviewDraftSchema, 404: errorResponseSchema },
      },
    },
    async (request) =>
      getDraft(app.firebase.database, request.params.clientId, request.params.reviewId),
  );

  // PATCH /api/coaching/clients/:clientId/reviews/:reviewId/draft —
  // autosave (REV-02/D-07). A stale `expectedRevision` maps to 409 with the
  // server draft attached, so the composer can offer conflict recovery.
  app.patch(
    '/coaching/clients/:clientId/reviews/:reviewId/draft',
    {
      schema: {
        params: reviewIdParamsSchema,
        body: createDraftPatchInputSchema,
        response: {
          200: reviewDraftSchema,
          404: errorResponseSchema,
          409: draftConflictResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        await autosaveDraft(
          app.firebase.database,
          request.params.clientId,
          request.params.reviewId,
          { sections: request.body.sections, coachPrivateNotes: request.body.coachPrivateNotes },
          request.body.expectedRevision,
        );
        return await getDraft(
          app.firebase.database,
          request.params.clientId,
          request.params.reviewId,
        );
      } catch (err) {
        if (err instanceof DraftConflictError) {
          return reply.code(409).send({
            error: 'Conflict',
            message: err.message,
            statusCode: 409,
            serverDraft: err.serverDraft,
          });
        }
        throw err;
      }
    },
  );

  // GET /api/coaching/clients/:clientId/reviews/:reviewId/preview — the
  // EXACT same transform `publishReview` seals, read-only (REV-05).
  app.get(
    '/coaching/clients/:clientId/reviews/:reviewId/preview',
    {
      schema: {
        params: reviewIdParamsSchema,
        response: { 200: clientVisibleVersionSchema, 404: errorResponseSchema },
      },
    },
    async (request) =>
      previewClientVersion(app.firebase.database, request.params.clientId, request.params.reviewId),
  );

  // POST /api/coaching/clients/:clientId/reviews/:reviewId/publish —
  // server-authoritative seal (D-06/T-12-06); the body accepts NO content
  // field (see `publishBodySchema`). Fires coach_review_published for v1
  // or review_revision_published for vN AFTER the durable write commits.
  app.post(
    '/coaching/clients/:clientId/reviews/:reviewId/publish',
    {
      schema: {
        params: reviewIdParamsSchema,
        body: publishBodySchema,
        response: { 200: publishResultSchema, 404: errorResponseSchema },
      },
    },
    async (request) =>
      publishReview(app.firebase.database, request.params.clientId, request.params.reviewId, {
        coachUid: request.uid,
        sessionId: sessionIdFromHeader(request),
      }),
  );

  // POST /api/coaching/clients/:clientId/reviews/:reviewId/sections/:sectionId/hide
  // (D-03: overflow action "Hide section", content preserved, Undo-able).
  app.post(
    '/coaching/clients/:clientId/reviews/:reviewId/sections/:sectionId/hide',
    {
      schema: {
        params: sectionParamsSchema,
        response: { 200: reviewDraftSchema, 404: errorResponseSchema },
      },
    },
    async (request) =>
      setSectionHidden(
        app.firebase.database,
        request.params.clientId,
        request.params.reviewId,
        request.params.sectionId,
        true,
      ),
  );

  // POST /api/coaching/clients/:clientId/reviews/:reviewId/sections/:sectionId/show
  // — the Undo counterpart (restores a hidden section without duplicating).
  app.post(
    '/coaching/clients/:clientId/reviews/:reviewId/sections/:sectionId/show',
    {
      schema: {
        params: sectionParamsSchema,
        response: { 200: reviewDraftSchema, 404: errorResponseSchema },
      },
    },
    async (request) =>
      setSectionHidden(
        app.firebase.database,
        request.params.clientId,
        request.params.reviewId,
        request.params.sectionId,
        false,
      ),
  );

  // POST /api/coaching/clients/:clientId/reviews/:reviewId/sections —
  // `Add section` (D-03): restores a hidden suggested block in place, or
  // appends a new General Notes / optional SSBU-specific section.
  app.post(
    '/coaching/clients/:clientId/reviews/:reviewId/sections',
    {
      schema: {
        params: reviewIdParamsSchema,
        body: addSectionBodySchema,
        response: {
          200: reviewDraftSchema,
          403: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request) =>
      addSection(app.firebase.database, request.params.clientId, request.params.reviewId, {
        kind: request.body.kind,
        title: request.body.title,
      }),
  );

  // POST /api/coaching/clients/:clientId/reviews/:reviewId/archive
  app.post(
    '/coaching/clients/:clientId/reviews/:reviewId/archive',
    {
      schema: {
        params: reviewIdParamsSchema,
        response: { 204: z.undefined(), 404: errorResponseSchema },
      },
    },
    async (request, reply) => {
      await archiveReview(app.firebase.database, request.params.clientId, request.params.reviewId);
      return reply.code(204).send();
    },
  );
};

export default coachingReviewsRoutes;
