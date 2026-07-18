import Fastify, { type FastifyBaseLogger, type FastifyError, type FastifyRequest } from 'fastify';
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
import groupsRoutes from './routes/groups.js';
import playlistsRoutes from './routes/playlists.js';
import vodSharesRoutes from './routes/vodShares.js';
import publicVodSharesRoutes from './routes/publicVodShares.js';
import coachNotesRoutes from './routes/coachNotes.js';
import eventsRoutes from './routes/events.js';
import shareMetaRoutes from './routes/shareMeta.js';
import shareOgImageRoutes from './routes/shareOgImage.js';
import { ConflictError, NotFoundError } from './services/rtdb.js';
import type { FirebaseServices } from './firebase/admin.js';
import type {
  Ga4Config,
  ParryggConfig,
  ReportsConfig,
  StartggConfig,
  StripeConfig,
} from './config/env.js';
import type { AnthropicLikeClient } from './reports/generate.js';
import type { ParryggClients } from './parrygg/client.js';

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
  logger?: boolean | FastifyBaseLogger;
}

/**
 * Phase 6 (Anonymous Share Experience & Discord Unfurls): rate-limit key for
 * the anonymous share routes. Deliberately NOT `request.ip`: with
 * `trustProxy: true`, `request.ip` resolves to the LEFTMOST X-Forwarded-For
 * entry, which is client-supplied — Cloud Run's front end APPENDS the real
 * client address to whatever XFF the caller sent, it never strips
 * caller-supplied entries. Keying on the leftmost entry therefore lets an
 * anonymous caller mint a fresh 60/min bucket per request by rotating a
 * spoofed header (TRUST-01 bypass). The RIGHTMOST entry is the one the
 * trusted Google front end actually appended — the closest-to-us,
 * non-spoofable address — so that is the key, falling back to the raw
 * socket address when no XFF header is present (direct connection).
 */
function anonRateLimitKey(request: FastifyRequest): string {
  const xff = request.headers['x-forwarded-for'];
  // Multiple header instances arrive as an array; the trusted proxy appends
  // to the last one, so take the final entry of the final header value.
  const headerValue = Array.isArray(xff) ? xff[xff.length - 1] : xff;
  if (headerValue) {
    const last = headerValue.split(',').pop()?.trim();
    if (last) return last;
  }
  return request.socket.remoteAddress ?? request.ip;
}

export function buildApp(options: BuildAppOptions) {
  const app = Fastify({
    logger: options.logger ?? true,
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
      await api.register(groupsRoutes);
      await api.register(playlistsRoutes);
      await api.register(vodSharesRoutes, {
        webBaseUrl: options.webBaseUrl ?? 'http://localhost:5173',
        ga4: options.ga4 ?? null,
        ga4Fetch: options.ga4Fetch,
      });
      await api.register(publicVodSharesRoutes);
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
