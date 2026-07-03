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
import { NotFoundError } from './services/rtdb.js';
import type { FirebaseServices } from './firebase/admin.js';

export interface BuildAppOptions {
  firebase: FirebaseServices;
  /** One origin, or multiple (e.g. parsed from a comma-separated env var). */
  corsOrigin?: string | string[];
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
    },
    { prefix: '/api' },
  );

  return app;
}
