import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  errorResponseSchema,
  homeworkItemSchema,
  HOMEWORK_ITEM_TEXT_MAX_LENGTH,
  MAX_SESSION_CHARACTER_TAGS,
  MAX_SESSION_HOMEWORK_ITEMS,
  MAX_SESSION_LINKED_MATCH_IDS,
  sessionPatchInputSchema,
  SAFE_MARKDOWN_DOC_MAX_LENGTH,
  type HomeworkItem,
  type TrainingSession,
} from '@smash-tracker/shared';
import { requireMembership } from '../coaching/tenants.js';
import {
  createSession,
  getSession,
  listSessions,
  toggleHomeworkItem,
  updateSession,
} from '../coaching/sessions.js';

const clientIdParamsSchema = z.object({ clientId: z.string().min(1) });
const sessionIdParamsSchema = z.object({
  clientId: z.string().min(1),
  sessionId: z.string().min(1),
});
const homeworkItemParamsSchema = z.object({
  clientId: z.string().min(1),
  sessionId: z.string().min(1),
  itemId: z.string().min(1),
});

/** Homework item as accepted on CREATE — no `id` (the service generates one per item). */
const homeworkItemCreateInputSchema = z.object({
  text: z.string().trim().max(HOMEWORK_ITEM_TEXT_MAX_LENGTH),
  done: z.boolean().optional(),
});

const createSessionBodySchema = z.object({
  date: z.number().int().nonnegative(),
  characterTags: z.array(z.number().int().positive()).max(MAX_SESSION_CHARACTER_TAGS).optional(),
  summary: z.string().max(SAFE_MARKDOWN_DOC_MAX_LENGTH),
  homework: z.array(homeworkItemCreateInputSchema).max(MAX_SESSION_HOMEWORK_ITEMS).optional(),
  linkedMatchIds: z.array(z.string().min(1)).max(MAX_SESSION_LINKED_MATCH_IDS).nullish(),
  coachPrivateNotes: z.string().max(SAFE_MARKDOWN_DOC_MAX_LENGTH).nullish(),
});

const toggleHomeworkBodySchema = z.object({ done: z.boolean() });

/**
 * Wire-response shape for a session — `.nullable()`, never `.nullish()`, on
 * `linkedMatchIds`/`coachPrivateNotes` (response-safe convention,
 * `reviewDeliveries.ts`'s documented precedent). `toSessionResponse` below
 * normalizes the service's `.nullish()`-shaped record to this before every
 * response.
 */
const sessionResponseSchema = z.object({
  sessionId: z.string().min(1),
  date: z.number().int().nonnegative(),
  characterTags: z.array(z.number().int().positive()).max(MAX_SESSION_CHARACTER_TAGS),
  summary: z.string().max(SAFE_MARKDOWN_DOC_MAX_LENGTH),
  homework: z.array(homeworkItemSchema).max(MAX_SESSION_HOMEWORK_ITEMS),
  linkedMatchIds: z.array(z.string().min(1)).max(MAX_SESSION_LINKED_MATCH_IDS).nullable(),
  coachPrivateNotes: z.string().max(SAFE_MARKDOWN_DOC_MAX_LENGTH).nullable(),
  createdAt: z.number().int().nonnegative(),
  lastEditedAt: z.number().int().nonnegative(),
});

function toSessionResponse(session: { sessionId: string } & TrainingSession) {
  return {
    ...session,
    linkedMatchIds: session.linkedMatchIds ?? null,
    coachPrivateNotes: session.coachPrivateNotes ?? null,
  };
}

/**
 * Phase 20 (Coaching Workflow, Training Sessions & VOD-less Reviews,
 * SESS-01/02): the coach-side training-session CRUD routes, nested under
 * `/api/coaching/clients/:clientId/sessions` — the SAME direct
 * `requireMembership` gating (URL `:clientId` param, no `X-Active-Subject`
 * header) as `coachingReviews.ts`'s sibling review routes. No delivery
 * events are emitted here — a bare CRUD save has no delivery transition
 * (that's Phase 20 Plan 03's `sessionDeliveries.ts`/routes).
 */
const coachingSessionsRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.authenticate);
  app.addHook('preHandler', async (request) => {
    const { clientId } = request.params as { clientId?: string };
    if (clientId) {
      await requireMembership(app.firebase.database, request.uid, clientId);
    }
  });

  // POST /api/coaching/clients/:clientId/sessions — log a new session (SESS-01).
  app.post(
    '/coaching/clients/:clientId/sessions',
    {
      schema: {
        params: clientIdParamsSchema,
        body: createSessionBodySchema,
        response: { 201: sessionResponseSchema },
      },
    },
    async (request, reply) => {
      const created = await createSession(app.firebase.database, request.params.clientId, {
        date: request.body.date,
        characterTags: request.body.characterTags,
        summary: request.body.summary,
        homework: request.body.homework,
        linkedMatchIds: request.body.linkedMatchIds,
        coachPrivateNotes: request.body.coachPrivateNotes,
      });
      return reply.code(201).send(toSessionResponse(created));
    },
  );

  // GET /api/coaching/clients/:clientId/sessions — list a client's sessions (SESS-02).
  app.get(
    '/coaching/clients/:clientId/sessions',
    {
      schema: {
        params: clientIdParamsSchema,
        response: { 200: z.array(sessionResponseSchema) },
      },
    },
    async (request) => {
      const sessions = await listSessions(app.firebase.database, request.params.clientId);
      return sessions.map(toSessionResponse);
    },
  );

  // GET /api/coaching/clients/:clientId/sessions/:sessionId — read one session (SESS-02).
  app.get(
    '/coaching/clients/:clientId/sessions/:sessionId',
    {
      schema: {
        params: sessionIdParamsSchema,
        response: { 200: sessionResponseSchema, 404: errorResponseSchema },
      },
    },
    async (request) => {
      const session = await getSession(
        app.firebase.database,
        request.params.clientId,
        request.params.sessionId,
      );
      return toSessionResponse(session);
    },
  );

  // PATCH /api/coaching/clients/:clientId/sessions/:sessionId — in-place
  // edit (mutable log — no expectedRevision/version machinery).
  app.patch(
    '/coaching/clients/:clientId/sessions/:sessionId',
    {
      schema: {
        params: sessionIdParamsSchema,
        body: sessionPatchInputSchema,
        response: { 200: sessionResponseSchema, 404: errorResponseSchema },
      },
    },
    async (request) => {
      const updated = await updateSession(
        app.firebase.database,
        request.params.clientId,
        request.params.sessionId,
        request.body as {
          date?: number;
          characterTags?: number[];
          summary?: string;
          homework?: HomeworkItem[];
          linkedMatchIds?: string[] | null;
          coachPrivateNotes?: string | null;
        },
      );
      return toSessionResponse(updated);
    },
  );

  // POST /api/coaching/clients/:clientId/sessions/:sessionId/homework/:itemId/toggle
  // — flips one homework item's done-state in place.
  app.post(
    '/coaching/clients/:clientId/sessions/:sessionId/homework/:itemId/toggle',
    {
      schema: {
        params: homeworkItemParamsSchema,
        body: toggleHomeworkBodySchema,
        response: { 200: sessionResponseSchema, 404: errorResponseSchema },
      },
    },
    async (request) => {
      const updated = await toggleHomeworkItem(
        app.firebase.database,
        request.params.clientId,
        request.params.sessionId,
        request.params.itemId,
        request.body.done,
      );
      return toSessionResponse(updated);
    },
  );
};

export default coachingSessionsRoutes;
