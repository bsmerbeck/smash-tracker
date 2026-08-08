import Fastify, { type FastifyBaseLogger, type FastifyError } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { healthCheckSchema } from '@smash-tracker/shared';
import firebasePlugin from './plugins/firebase.js';
import authPlugin from './plugins/auth.js';
import resolveSubjectPlugin from './plugins/resolveSubject.js';
import usersRoutes from './routes/users.js';
import matchesRoutes from './routes/matches.js';
import opponentsRoutes from './routes/opponents.js';
import opponentAliasesRoutes from './routes/opponentAliases.js';
import opponentNotesRoutes from './routes/opponentNotes.js';
import gspSettingsRoutes from './routes/gspSettings.js';
import gspReadingsRoutes from './routes/gspReadings.js';
import gspLiveRoutes from './routes/gspLive.js';
import stageFavoritesRoutes from './routes/stageFavorites.js';
import startggRoutes from './routes/startgg.js';
import parryggRoutes from './routes/parrygg.js';
import parryggAuthRoutes from './routes/parryggAuth.js';
import scoutRoutes from './routes/scout.js';
import reportsRoutes from './routes/reports.js';
import billingRoutes, { type StripeLikeClient } from './routes/billing.js';
import tournamentsRoutes from './routes/tournaments.js';
import prepRoutes from './routes/prep.js';
import prepBindingsRoutes from './routes/prepBindings.js';
import onboardingRoutes from './routes/onboarding.js';
import groupsRoutes from './routes/groups.js';
import playlistsRoutes from './routes/playlists.js';
import coachingTenantsRoutes from './routes/coachingTenants.js';
import coachingReviewsRoutes from './routes/coachingReviews.js';
import coachingReviewDeliveriesRoutes from './routes/coachingReviewDeliveries.js';
import coachingSessionsRoutes from './routes/coachingSessions.js';
import coachingSessionDeliveriesRoutes from './routes/coachingSessionDeliveries.js';
import claimInvitationsRoutes from './routes/claimInvitations.js';
import claimsRoutes from './routes/claims.js';
import claimDelegationsRoutes from './routes/claimDelegations.js';
import clientWorkspacesRoutes from './routes/clientWorkspaces.js';
import vodSharesRoutes from './routes/vodShares.js';
import publicVodSharesRoutes from './routes/publicVodShares.js';
import publicReviewDeliveriesRoutes from './routes/publicReviewDeliveries.js';
import coachNotesRoutes from './routes/coachNotes.js';
import eventsRoutes from './routes/events.js';
import internalJobsRoutes from './routes/internalJobs.js';
import shareMetaRoutes from './routes/shareMeta.js';
import shareOgImageRoutes from './routes/shareOgImage.js';
import researchTenantsRoutes from './routes/research.js';
import { ConflictError, ForbiddenError, NotFoundError } from './services/rtdb.js';
import type { FirebaseServices } from './firebase/admin.js';
import type {
  ClaimCodeConfig,
  Ga4Config,
  InternalJobsConfig,
  ParryggConfig,
  PrepPaidConfig,
  ReportsConfig,
  ResearchConfig,
  StartggConfig,
  StripeConfig,
} from './config/env.js';
import type { AnthropicLikeClient } from './reports/generate.js';
import type { ParryggClients } from './parrygg/client.js';
import { anonRateLimitKey } from './http/clientIp.js';

declare module 'fastify' {
  interface FastifyInstance {
    /**
     * Phase 29 (Research Tenancy, Isolation & Governance Gate, D-04): the
     * research-admin allowlist config, decorated directly (never routed
     * through a route-registration options object) so every route file
     * reads ONE server-authoritative value via `app.researchConfig`. Always
     * present as a decoration — holds null when the `research` build
     * option is omitted or explicitly null, matching every other
     * config-null gate's fail-closed contract in this file.
     */
    researchConfig: ResearchConfig | null;
  }
}

export interface BuildAppOptions {
  firebase: FirebaseServices;
  /** One origin, or multiple (e.g. parsed from a comma-separated env var). */
  corsOrigin?: string | string[];
  /** Overridable fetch for the gsptiers.com live-thresholds call (tests). Defaults to global fetch — no prod config needed. */
  gspLiveFetch?: typeof fetch;
  /** start.gg integration config; null/omitted disables those routes (503). */
  startgg?: StartggConfig | null;
  /** Overridable fetch for the start.gg OAuth/GraphQL calls (tests). */
  startggFetch?: typeof fetch;
  /** parry.gg integration config; null/omitted disables those routes (503). */
  parrygg?: ParryggConfig | null;
  /** Overridable parry.gg gRPC-Web service clients (tests) — see parrygg/client.ts. */
  parryggClients?: ParryggClients;
  /** AI reports config; null/omitted disables /api/reports (503). */
  reports?: ReportsConfig | null;
  /** Overridable Anthropic client for /api/reports (tests). */
  reportsClient?: AnthropicLikeClient;
  /** Stripe billing config; null/omitted disables /api/billing (503) and gates /api/reports to allowlist-only (pre-V7-C behavior). */
  stripe?: StripeConfig | null;
  /** SPA origin Stripe Checkout redirects back to (`env.WEB_BASE_URL`). */
  webBaseUrl?: string;
  /** Overridable Stripe client for /api/billing (tests). */
  stripeClient?: StripeLikeClient;
  /**
   * Overridable fetch for GET /s/:token and /s/:token/og.png's shell/sprite/
   * static-fallback-image fetches (tests). Defaults to global fetch — no
   * prod config needed (mirrors gspLiveFetch/startggFetch).
   */
  shareFetch?: typeof fetch;
  /**
   * GA4 Measurement Protocol config; null/omitted makes the fire-and-forget
   * `review_shared` server event a silent no-op (never a 503 — GA4 is
   * instrumentation on an existing route, not a route of its own).
   */
  ga4?: Ga4Config | null;
  /** Overridable fetch for the GA4 Measurement Protocol POST (tests). */
  ga4Fetch?: typeof fetch;
  /**
   * Phase 10 (Canonical Measurement & Money Safety): shared-secret config
   * for the Cloud-Scheduler-facing `/internal/jobs/*` scope; null/omitted
   * makes the ENTIRE scope answer 503 (never a silently-open route).
   */
  internalJobs?: InternalJobsConfig | null;
  /**
   * Phase 23 (Claim Credential & Atomic Ownership Transition, CRED-02): the
   * HMAC config for claim-code hashing. Null/omitted makes the entire claim
   * issuance + redemption surface answer 503 (routes are registered in
   * later plans of this phase; this option is threaded but not yet
   * consumed by any route here).
   */
  claimCode?: ClaimCodeConfig | null;
  /**
   * Phase 27 (Contextual Paid Prep Reports Behind the Activation Gate,
   * RPT-04): the server-side activation gate for paid prep reports/bundles.
   * Null/omitted (the default) keeps `paidReportsAvailable` false and makes
   * `POST /api/reports` answer 503 for every prep-context request, even for
   * an allowlisted uid — gate-off never blocks legacy report generation,
   * reads, refunds, or Stripe fulfillment.
   */
  prepPaid?: PrepPaidConfig | null;
  /**
   * Phase 29 (Research Tenancy, Isolation & Governance Gate, D-04): the
   * research-tenant administration allowlist. Optional AND nullable —
   * review finding 29-01 MEDIUM — so every existing construction site
   * (including tests that build the app directly) keeps compiling and
   * receives the fail-closed null. Decorated onto the app instance as
   * `researchConfig`; see the `declare module 'fastify'` block above.
   */
  research?: ResearchConfig | null;
  logger?: boolean | FastifyBaseLogger;
}

export function buildApp(options: BuildAppOptions) {
  const loggerOption = options.logger ?? true;
  const app = Fastify({
    // Fastify 5 accepts a boolean or a pino CONFIG object under `logger`,
    // but a pre-built logger INSTANCE (e.g. Plan 05's raw-code-isolation
    // capturing logger) must go through the separate `loggerInstance`
    // option — passing an instance object under `logger` throws
    // "logger options only accepts a configuration object" at startup.
    ...(typeof loggerOption === 'boolean'
      ? { logger: loggerOption }
      : { loggerInstance: loggerOption }),
    // Phase 6 (Anonymous Share Experience & Discord Unfurls): lets Fastify
    // parse X-Forwarded-For at all (behind a Firebase Hosting rewrite to
    // Cloud Run the raw socket peer is Google's internal proxy hop, never
    // the visitor — RESEARCH.md Pattern 3 / Pitfall 1). NOTE: `true` makes
    // `request.ip` the LEFTMOST (client-spoofable) XFF entry, so the rate
    // limiter must NOT key on `request.ip` — see `anonRateLimitKey` above,
    // which keys on the rightmost (trusted-proxy-appended) entry instead.
    trustProxy: true,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.register(cors, {
    origin: options.corsOrigin ?? 'http://localhost:5173',
  });

  // Registered top-level with global:false so every existing (authenticated)
  // route is completely unaffected — only routes that opt in via a
  // per-route `config: { rateLimit: {...} }` (currently just the anonymous
  // GET /api/vod-shares/:token) are actually rate-limited (RESEARCH.md
  // Pattern 2, TRUST-01). `keyGenerator` buckets by the non-spoofable
  // rightmost X-Forwarded-For entry, never `request.ip` — see
  // `anonRateLimitKey`.
  app.register(rateLimit, { global: false, keyGenerator: anonRateLimitKey });

  app.register(firebasePlugin, options.firebase);
  app.register(authPlugin);
  // Phase 11 (Coach Workspace Tenancy & Feature Parity, TEN-02): sibling of
  // authPlugin, registered top-level (NOT inside the `/api` scope) so the
  // `app.resolveSubject` decorator is available to every route file that
  // opts in via its own `app.addHook('preHandler', app.resolveSubject)`.
  // Never registered as a route-scoped hook itself — see
  // apps/api/src/plugins/resolveSubject.ts for why per-file opt-in (not
  // global registration) is the correct boundary.
  app.register(resolveSubjectPlugin);

  // Phase 29 (Research Tenancy, Isolation & Governance Gate, D-04): decorate
  // directly rather than via a plugin — this is a single config-null value,
  // not a service with its own lifecycle. Always present as a decoration
  // (never undefined); holds null when the option is omitted or explicit
  // null, so every route file can read `app.researchConfig` unconditionally.
  app.decorate('researchConfig', options.research ?? null);

  app.setErrorHandler<FastifyError>((error, request, reply) => {
    if (hasZodFastifySchemaValidationErrors(error)) {
      reply.code(400).send({
        error: 'Bad Request',
        message: "Request doesn't match the required schema",
        statusCode: 400,
        details: error.validation,
      });
      return;
    }

    if (isResponseSerializationError(error)) {
      request.log.error({ err: error }, 'Response failed schema validation');
      reply.code(500).send({
        error: 'Internal Server Error',
        message: 'An unexpected error occurred',
        statusCode: 500,
      });
      return;
    }

    if (error instanceof NotFoundError) {
      reply.code(404).send({
        error: 'Not Found',
        message: error.message,
        statusCode: 404,
      });
      return;
    }

    if (error instanceof ConflictError) {
      reply.code(409).send({
        error: 'Conflict',
        message: error.message,
        statusCode: 409,
      });
      return;
    }

    // Phase 11 (TEN-02): `app.resolveSubject` throws `ForbiddenError` from a
    // preHandler, which runs BEFORE the route handler body — a route's own
    // local `if (err instanceof ForbiddenError)` try/catch (used elsewhere
    // for in-handler errors like the playlist cap) never sees it, so this
    // needs its own global mapping, mirroring NotFoundError/ConflictError
    // above.
    if (error instanceof ForbiddenError) {
      reply.code(403).send({
        error: 'Forbidden',
        message: error.message,
        statusCode: 403,
      });
      return;
    }

    const statusCode = error.statusCode ?? 500;
    if (statusCode < 500) {
      reply.code(statusCode).send({
        error: error.name || 'Bad Request',
        message: error.message,
        statusCode,
      });
      return;
    }

    request.log.error({ err: error }, 'Unhandled error');
    reply.code(500).send({
      error: 'Internal Server Error',
      message: 'An unexpected error occurred',
      statusCode: 500,
    });
  });

  app.get(
    '/healthz',
    {
      schema: {
        response: {
          200: healthCheckSchema,
        },
      },
    },
    async () => {
      return { status: 'ok' } as const;
    },
  );

  // Phase 6 (Anonymous Share Experience & Discord Unfurls): GET /s/:token
  // and GET /s/:token/og.png are root-scoped — NOT under `/api` — so their
  // literal paths match firebase.json's new `/s/**` Hosting rewrite
  // (Anti-Pattern: registering these under `/api` would silently 404
  // against that rewrite, since Hosting forwards the literal path rather
  // than stripping a prefix). Each gets its own scoped @fastify/rate-limit
  // instance (60/min) rather than reusing the `/api` block's top-level
  // `global: false` registration, since these routes live in a sibling
  // scope, not inside `/api` (RESEARCH.md Pattern 2, TRUST-01).
  app.register(
    async (anon) => {
      await anon.register(rateLimit, {
        max: 60,
        timeWindow: '1 minute',
        keyGenerator: anonRateLimitKey,
      });
      await anon.register(shareMetaRoutes, {
        webBaseUrl: options.webBaseUrl ?? 'http://localhost:5173',
        fetchImpl: options.shareFetch,
      });
      await anon.register(shareOgImageRoutes, {
        webBaseUrl: options.webBaseUrl ?? 'http://localhost:5173',
        fetchImpl: options.shareFetch,
      });
    },
    { prefix: '/' },
  );

  // Phase 10 Plan 5 (Canonical Measurement & Money Safety): the
  // Cloud-Scheduler-facing internal job routes — root-scoped (NOT under
  // `/api`), a sibling to the `/s/**` block above, so Cloud Scheduler's HTTP
  // target hits the literal `/internal/jobs/*` path. Gated internally by the
  // shared-secret preHandler in internalJobs.ts (503 when unconfigured, 401
  // on a missing/wrong secret) — never protected by the anonymous
  // rate-limiter above, which is irrelevant to this scope's own auth model.
  app.register(internalJobsRoutes, {
    internalJobs: options.internalJobs ?? null,
    ga4: options.ga4 ?? null,
    ga4Fetch: options.ga4Fetch,
    // Phase 30 Plan 07: the research-backfill internal job needs the
    // start.gg server token; a null config makes exactly that route answer
    // 503 while every sibling job keeps its existing behavior.
    startgg: options.startgg ?? null,
    startggFetch: options.startggFetch,
  });

  // Phase 27 (RPT-04): the single boolean derivation that crosses the prep
  // import-graph boundary. This computation lives HERE — not inside
  // `apps/api/src/prep/` — because that module carries a byte-scanned
  // import-graph gate (`importGraph.test.ts`) and must never learn about the
  // reports or billing subsystems, even at the type level (27-CONTEXT.md
  // line 23, 27-RESEARCH.md Pattern 2). `paidReportsAvailable` is true only
  // when the prep-paid activation flag AND the reports config AND the
  // stripe config are all present — the same three-config "fully present or
  // fully off" convention `getStripeConfig`/`getReportsConfig` already use.
  const paidReportsAvailable = Boolean(options.prepPaid && options.reports && options.stripe);

  app.register(
    async (api) => {
      await api.register(usersRoutes);
      await api.register(matchesRoutes);
      await api.register(opponentsRoutes);
      await api.register(opponentAliasesRoutes);
      await api.register(opponentNotesRoutes);
      await api.register(gspSettingsRoutes);
      await api.register(gspReadingsRoutes);
      await api.register(gspLiveRoutes, { fetchImpl: options.gspLiveFetch });
      await api.register(stageFavoritesRoutes);
      await api.register(tournamentsRoutes);
      // Phase 26 (PREP-01..04): the event-bound free prep brief,
      // personal-only (always request.uid), mirroring tournamentsRoutes'
      // authenticate-only registration shape immediately above.
      await api.register(prepRoutes, { paidReportsAvailable });
      // Phase 27 (RPT-01/RPT-02, 27-06): the scoutBinding candidate-list,
      // confirm, and clear routes — a sibling of prepRoutes above rather
      // than folded into it, because binding resolution needs the start.gg
      // and parry.gg scout resolvers and prepRoutes/prep/ deliberately
      // never learn about them (import-graph gate).
      await api.register(prepBindingsRoutes, {
        startggConfig: options.startgg ?? null,
        parryggConfig: options.parrygg ?? null,
        fetchImpl: options.startggFetch,
        parryggClients: options.parryggClients,
      });
      // Phase 13 (ONBD-04, D-04): the guided-path checklist's
      // server-derived activation done-states — personal-only (always
      // request.uid), mirroring tournamentsRoutes' minimal
      // authenticate-only registration shape above.
      await api.register(onboardingRoutes);
      await api.register(groupsRoutes);
      await api.register(playlistsRoutes);
      await api.register(coachingTenantsRoutes);
      await api.register(coachingReviewsRoutes);
      await api.register(coachingReviewDeliveriesRoutes, {
        webBaseUrl: options.webBaseUrl ?? 'http://localhost:5173',
      });
      // Phase 20 Plan 02 (Coaching Workflow, SESS-01/02): the coach-side
      // training-session CRUD routes, gated the same direct
      // requireMembership way as coachingReviewsRoutes above.
      await api.register(coachingSessionsRoutes);
      // Phase 20 Plan 03 (SESS-01/02, D-10): the coach-side session
      // delivery-management routes, mirroring coachingReviewDeliveriesRoutes'
      // own registration shape exactly.
      await api.register(coachingSessionDeliveriesRoutes, {
        webBaseUrl: options.webBaseUrl ?? 'http://localhost:5173',
      });
      // Phase 23 Plan 04 (Claim Credential & Atomic Ownership Transition,
      // CRED-01/CRED-02/CRED-03): the coach-side claim-invitation routes,
      // config-null 503-gated on CLAIM_CODE_HMAC_SECRET.
      await api.register(claimInvitationsRoutes, { claimCode: options.claimCode ?? null });
      // Phase 23 Plan 05 (Claim Credential & Atomic Ownership Transition,
      // CRED-05/CLAIM-02): the client-side claim-redemption route — the
      // sibling to claimInvitationsRoutes above, same config-null 503 gate.
      await api.register(claimsRoutes, { claimCode: options.claimCode ?? null });
      // Phase 23 Plan 06 (CLAIM-03/CTRL-02): the client-owner-facing
      // delegation-revoke route — registered unconditionally (no claim code
      // is involved in revoking a delegation).
      await api.register(claimDelegationsRoutes);
      // Phase 24 Plan 01 (Coach Issuance & Client Claim Experience,
      // CTRL-01/CTRL-02): the client-owner-facing workspace-listing route —
      // registered unconditionally, no options object (no claim code/HMAC
      // secret is involved in listing one's own owned workspaces).
      await api.register(clientWorkspacesRoutes);
      // Phase 29 (Research Tenancy, Isolation & Governance Gate, RTEN-01,
      // D-04): the admin-only research tenant collection routes. Phase 30
      // Plan 07 extends this SAME registration with the start.gg server
      // token the backfill routes need — a null config makes exactly those
      // routes answer 503 while the tenant and entitlement routes keep
      // their existing unconditional behavior. Registered UNCONDITIONALLY
      // — no research-config-null 503 gate here, since route PRESENCE
      // itself must leak nothing; that config-null check lives inside the
      // route handlers via `requireResearchAdmin` instead (see
      // `apps/api/src/routes/research.ts`'s module comment).
      await api.register(researchTenantsRoutes, {
        startgg: options.startgg ?? null,
        startggFetch: options.startggFetch,
      });
      await api.register(vodSharesRoutes, {
        webBaseUrl: options.webBaseUrl ?? 'http://localhost:5173',
        ga4: options.ga4 ?? null,
        ga4Fetch: options.ga4Fetch,
      });
      await api.register(publicVodSharesRoutes);
      // Phase 12 Plan 05 (DLV-02/DLV-03): the anonymous no-account coach
      // review delivery surface — same public/no-store/rate-limited posture
      // as `publicVodSharesRoutes` above.
      await api.register(publicReviewDeliveriesRoutes);
      // Phase 10 Plan 4 (Canonical Measurement): the durable, same-origin
      // X-class ingestion route — anonymous-tolerant (no `app.authenticate`,
      // same posture as `publicVodSharesRoutes` above), per-route rate
      // limited via `config.rateLimit` inside `events.ts` itself (MEAS-04).
      await api.register(eventsRoutes);
      // Phase 8 Plan 3 (Coaching Edit Sessions): the anonymous coach
      // surface gets its own encapsulated scope carrying TWO stacked
      // @fastify/rate-limit registrations (RESEARCH's nested-scope pattern,
      // verified by coachNotes.test.ts's spike tests): an outer per-IP
      // floor (generous, defense-in-depth — keyed on `anonRateLimitKey`'s
      // non-spoofable rightmost-XFF entry, reused verbatim) wrapping an
      // inner per-TOKEN 20/min bucket (the locked primary write limit —
      // rotating spoofed IPs cannot mint a fresh bucket for one leaked
      // token, and one hot token cannot starve other tokens' buckets).
      // Encapsulation keeps both instances entirely off every other route.
      await api.register(async (coachScope) => {
        await coachScope.register(rateLimit, {
          max: 100,
          timeWindow: '1 minute',
          keyGenerator: anonRateLimitKey,
        });
        await coachScope.register(async (perToken) => {
          await perToken.register(rateLimit, {
            max: 20,
            timeWindow: '1 minute',
            keyGenerator: (req) =>
              (req.params as { token?: string }).token ?? anonRateLimitKey(req),
          });
          await perToken.register(coachNotesRoutes);
        });
      });
      await api.register(startggRoutes, {
        config: options.startgg ?? null,
        fetchImpl: options.startggFetch,
      });
      await api.register(parryggRoutes, {
        config: options.parrygg ?? null,
        clients: options.parryggClients,
      });
      await api.register(parryggAuthRoutes, {
        config: options.parrygg ?? null,
        clients: options.parryggClients,
      });
      await api.register(scoutRoutes, {
        config: options.startgg ?? null,
        fetchImpl: options.startggFetch,
        parryggConfig: options.parrygg ?? null,
        parryggClients: options.parryggClients,
      });
      await api.register(reportsRoutes, {
        config: options.reports ?? null,
        startggConfig: options.startgg ?? null,
        stripeConfig: options.stripe ?? null,
        prepPaidConfig: options.prepPaid ?? null,
        client: options.reportsClient,
        fetchImpl: options.startggFetch,
        parryggConfig: options.parrygg ?? null,
        parryggClients: options.parryggClients,
      });
      await api.register(billingRoutes, {
        stripeConfig: options.stripe ?? null,
        reportsConfig: options.reports ?? null,
        webBaseUrl: options.webBaseUrl ?? 'http://localhost:5173',
        stripeClient: options.stripeClient,
      });
    },
    { prefix: '/api' },
  );

  return app;
}
