import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { computeActivationState } from '../onboarding/activation.js';

const onboardingProgressSchema = z.object({
  analytics: z.boolean(),
  vod: z.boolean(),
  tournamentPrep: z.boolean(),
  scout: z.boolean(),
});

/**
 * GET /api/onboarding/progress — the guided-path checklist's server-derived
 * done-states (ONBD-04, D-04). Personal-only, always `request.uid` (never
 * subject-resolved — mirrors `PUT /users/me`'s own personal-only posture,
 * T-13-04-03): a coach's onboarding checklist is their OWN player
 * activation, never a managed client's. Reads `computeActivationState`,
 * which derives each boolean from the SAME `eventDedup` markers the four
 * player activation D events write — never a parallel client-facing
 * counter, so the checklist can never drift from the events that actually
 * fired.
 */
const onboardingRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.authenticate);

  app.get(
    '/onboarding/progress',
    {
      schema: {
        response: {
          200: onboardingProgressSchema,
        },
      },
    },
    async (request) => {
      return computeActivationState(app.firebase.database, request.uid);
    },
  );
};

export default onboardingRoutes;
