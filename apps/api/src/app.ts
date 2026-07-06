import Fastify, { type FastifyBaseLogger, type FastifyError } from 'fastify';
import cors from '@fastify/cors';
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
import startggRoutes from './routes/startgg.js';
import parryggRoutes from './routes/parrygg.js';
import parryggAuthRoutes from './routes/parryggAuth.js';
import scoutRoutes from './routes/scout.js';
import reportsRoutes from './routes/reports.js';
import billingRoutes, { type StripeLikeClient } from './routes/billing.js';
import tournamentsRoutes from './routes/tournaments.js';
import groupsRoutes from './routes/groups.js';
import { NotFoundError } from './services/rtdb.js';
import type { FirebaseServices } from './firebase/admin.js';
import type { ParryggConfig, ReportsConfig, StartggConfig, StripeConfig } from './config/env.js';
import type { AnthropicLikeClient } from './reports/generate.js';
import type { ParryggClients } from './parrygg/client.js';

export interface BuildAppOptions {
  firebase: FirebaseServices;
  /** One origin, or multiple (e.g. parsed from a comma-separated env var). */
  corsOrigin?: string | string[];
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
  logger?: boolean | FastifyBaseLogger;
}

export function buildApp(options: BuildAppOptions) {
  const app = Fastify({
    logger: options.logger ?? true,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.register(cors, {
    origin: options.corsOrigin ?? 'http://localhost:5173',
  });

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

  app.register(
    async (api) => {
      await api.register(usersRoutes);
      await api.register(matchesRoutes);
      await api.register(opponentsRoutes);
      await api.register(opponentAliasesRoutes);
      await api.register(opponentNotesRoutes);
      await api.register(tournamentsRoutes);
      await api.register(groupsRoutes);
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
      });
      await api.register(reportsRoutes, {
        config: options.reports ?? null,
        startggConfig: options.startgg ?? null,
        stripeConfig: options.stripe ?? null,
        client: options.reportsClient,
        fetchImpl: options.startggFetch,
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
