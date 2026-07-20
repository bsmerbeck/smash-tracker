import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import {
  fighterSelectionInputSchema,
  fighterSelectionSchema,
  ONBOARDING_INTENTS,
  userProfileSchema,
} from '@smash-tracker/shared';
import { z } from 'zod';
import { buildDomainEnvelope } from '../events/envelope.js';
import { createEvent } from '../events/ledger.js';
import { NotFoundError, RtdbService } from '../services/rtdb.js';

/**
 * Phase 11 (Coach Workspace Tenancy & Feature Parity, PAR-04): route
 * boundary for this file —
 *
 * SUBJECT-RESOLVED (opts into the resolver preHandler, may target a managed
 * client's tenant): `GET /users/me/fighters`, `PUT /users/me/fighters`,
 * nested below in their own sub-scope. A coaching request can only ever
 * read/write a client's fighter selection through these two routes.
 *
 * PERSONAL-ONLY (never subject-resolved, always `request.uid`): `PUT
 * /users/me` (profile/email upsert + `signup_completed` emission) and `GET
 * /users/me` (profile response, including its inline
 * `getFighterSelection(request.uid)` call — that call shapes the COACH's
 * OWN profile response, not a client-scoped read, and must stay on
 * `request.uid` even though it calls the identically-named RtdbService
 * method the fighters sub-scope below also calls). A coaching-mode request
 * can never overwrite or read the coach's own profile through a tenant
 * header.
 */
const usersRoutes: FastifyPluginAsyncZod = async (app) => {
  const rtdb = new RtdbService(app.firebase.database);

  app.addHook('preHandler', app.authenticate);

  // PUT /api/users/me — idempotent upsert. Replaces the legacy `createProfile`
  // Cloud Function (auth onCreate trigger writing `users/{uid} = { email }`),
  // deleted from the smash-tracker-f97b7 project on 2026-07-08. The user node
  // is now created only when the client calls this endpoint.
  //
  // Phase 7 (Recap Cards & Share-Loop Analytics): accepts an optional
  // `referredByShareId` body (FUNNEL-02) — the client reads its localStorage
  // share-referral stamp and passes it through on every provisioning call
  // (not just signup). The stamped value is the share-page route TOKEN (the
  // public snapshot never exposes a shareId); `RtdbService.upsertUser`
  // resolves it via `shareTokens/{token}` to the durable shareId before
  // storing (review CR-01) — an unresolvable token is silently dropped —
  // and applies write-once, first-touch semantics, so a returning user's
  // stale stamp can never overwrite an existing attribution.
  //
  // Phase 10 Plan 4 (Canonical Measurement, MEAS-02): this handler is the
  // ONLY place `signup_completed` can fire, and it must fire EXACTLY ONCE
  // per account — never client-mirrored. `upsertUser` runs on every sign-in
  // (idempotent), so "first-ever provision" is detected by reading
  // `users/{uid}/email`'s existence BEFORE the upsert write; a returning
  // user (email already present) emits nothing.
  app.put(
    '/users/me',
    {
      schema: {
        // `.nullish()`, not just `.optional()`: Fastify sets `request.body`
        // to `null` (not `undefined`) for a bodyless request with no
        // Content-Type header — the shape every pre-Phase-7 client sends.
        // `.max(128)` (review WR-02): a real stamped value is a 43-char
        // base64url share token (SHARE_TOKEN_SHAPE allows up to 128), so an
        // unbounded blob is rejected at the boundary before it can reach the
        // token lookup or round-trip through RTDB. Charset validation happens
        // in `upsertUser` (non-conforming values are silently dropped, never
        // an error — provisioning must not fail on a bad referral).
        //
        // Phase 11 walkthrough fix round 1 (FB-3): `coachingModeEnabled` is
        // the Profile > Account toggle — optional so every existing
        // provisioning caller (which never sends it) is untouched.
        //
        // Phase 13 (ONBD-02/D-01/D-02): `onboardingIntent` is the /welcome
        // chooser's selection; `onboardingAsked` distinguishes the
        // asked-vs-context-skipped cohort split the roadmap gate reads from
        // `onboarding_intent_selected`'s payload. Both optional so every
        // existing provisioning caller (which never sends either) is
        // untouched.
        body: z
          .object({
            referredByShareId: z.string().max(128).optional(),
            coachingModeEnabled: z.boolean().optional(),
            onboardingIntent: z.enum(ONBOARDING_INTENTS).optional(),
            onboardingAsked: z.boolean().optional(),
          })
          .nullish(),
        response: {
          200: z.object({ uid: z.string(), email: z.string().email() }),
        },
      },
    },
    async (request) => {
      const email = request.userEmail;

      const existingEmailSnapshot = await app.firebase.database
        .ref(`users/${request.uid}/email`)
        .get();
      const isFirstProvision = !existingEmailSnapshot.exists();

      // Phase 13 (T-13-02-01): read-before-write "did this actually
      // change" guards for both new D events, mirroring isFirstProvision
      // above — a repeated identical PUT must never inflate the ledger.
      const [previousIntentSnapshot, previousCoachingModeSnapshot] = await Promise.all([
        app.firebase.database.ref(`users/${request.uid}/onboardingIntent`).get(),
        app.firebase.database.ref(`users/${request.uid}/coachingModeEnabled`).get(),
      ]);
      const previousIntent = previousIntentSnapshot.val() as string | null;
      const previousCoachingModeEnabled = previousCoachingModeSnapshot.val() === true;

      await rtdb.upsertUser(request.uid, {
        email,
        // Wire name is `referredByShareId` for client back-compat, but the
        // VALUE is the share-page bearer token — upsertUser resolves it.
        referralToken: request.body?.referredByShareId,
        coachingModeEnabled: request.body?.coachingModeEnabled,
        onboardingIntent: request.body?.onboardingIntent,
      });

      const sessionIdHeader = request.headers['x-session-id'];
      const sessionId =
        (Array.isArray(sessionIdHeader) ? sessionIdHeader[0] : sessionIdHeader) ?? 'unknown';

      if (isFirstProvision) {
        void createEvent(
          app.firebase.database,
          buildDomainEnvelope({
            eventName: 'signup_completed',
            actorId: request.uid,
            sessionId,
            causationId: request.uid,
            consentState: 'unknown',
          }),
        );
      }

      // Phase 13 (ONBD-02/D-01/D-02): fires once per GENUINE intent change
      // — never on a repeat PUT with the same intent (T-13-02-01).
      if (
        request.body?.onboardingIntent !== undefined &&
        request.body.onboardingIntent !== previousIntent
      ) {
        void createEvent(
          app.firebase.database,
          buildDomainEnvelope({
            eventName: 'onboarding_intent_selected',
            actorId: request.uid,
            sessionId,
            causationId: request.uid,
            consentState: 'unknown',
            payload: {
              intent: request.body.onboardingIntent,
              asked: request.body.onboardingAsked === true,
            },
          }),
        );
      }

      // Phase 13 (ONBD-05/D-06, RESEARCH.md Pitfall 2): coaching_mode_enabled
      // was never wired before this phase — this is the newly-added
      // emission, gated on a genuine false/absent -> true flip only.
      if (request.body?.coachingModeEnabled === true && !previousCoachingModeEnabled) {
        void createEvent(
          app.firebase.database,
          buildDomainEnvelope({
            eventName: 'coaching_mode_enabled',
            actorId: request.uid,
            sessionId,
            causationId: request.uid,
            consentState: 'unknown',
          }),
        );
      }

      return { uid: request.uid, email };
    },
  );

  // GET /api/users/me — user node + fighter selections.
  app.get(
    '/users/me',
    {
      schema: {
        response: {
          200: userProfileSchema,
        },
      },
    },
    async (request) => {
      const [user, fighters] = await Promise.all([
        rtdb.getUser(request.uid),
        rtdb.getFighterSelection(request.uid),
      ]);

      if (!user) {
        throw new NotFoundError('User profile not found. Call PUT /api/users/me first.');
      }

      return {
        uid: request.uid,
        email: user.email,
        fighters,
        coachingModeEnabled: user.coachingModeEnabled ?? false,
        onboardingIntent: user.onboardingIntent ?? null,
      };
    },
  );

  // Phase 11 (PAR-03/PAR-04): the fighters sub-routes are the ONLY part of
  // usersRoutes that may target a managed client — nested so `resolveSubject`
  // never touches `/users/me` (mirrors app.ts's `coachNotesRoutes` nested-
  // scope registration pattern for scoping an extra hook to a subset of
  // routes within one file). Without this split, a coach could never set a
  // managed client's mains (blocking PAR-03 for every analytics page that
  // gates on `useFighters()`), or — the more dangerous alternative — a
  // coaching-mode request could accidentally overwrite the coach's own
  // fighter selection instead.
  await app.register(fightersSubScope(rtdb));
};

/**
 * A separate `FastifyPluginAsyncZod`-typed function (rather than an inline
 * `app.register(async (scope) => ...)` callback) is required here so
 * TypeScript correctly threads the `ZodTypeProvider` generic through the
 * nested scope's schema-typed `.get`/`.put` handlers — an inline arrow
 * callback loses that inference and leaves `request.body` typed `unknown`.
 */
function fightersSubScope(rtdb: RtdbService): FastifyPluginAsyncZod {
  return async (app) => {
    app.addHook('preHandler', app.resolveSubject);

    // GET /api/users/me/fighters
    app.get(
      '/users/me/fighters',
      {
        schema: {
          response: {
            200: fighterSelectionSchema,
          },
        },
      },
      async (request) => {
        return rtdb.getFighterSelection(request.subjectId);
      },
    );

    // PUT /api/users/me/fighters
    app.put(
      '/users/me/fighters',
      {
        schema: {
          body: fighterSelectionInputSchema,
          response: {
            200: fighterSelectionSchema,
          },
        },
      },
      async (request) => {
        await rtdb.setFighterSelection(request.subjectId, request.body);
        return request.body;
      },
    );
  };
}

export default usersRoutes;
