import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import {
  createGspReadingInputSchema,
  gspReadingSchema,
  updateGspReadingInputSchema,
} from '@smash-tracker/shared';
import { z } from 'zod';
import { RtdbService } from '../services/rtdb.js';

const readingIdParamsSchema = z.object({
  id: z.string().min(1),
});

/**
 * V17: `gspReadings/{uid}` — standalone "set GSP without a match"
 * calibration readings (community request; see
 * packages/shared/src/gspReading.ts for the data-model rationale). CRUD
 * mirrors the matches routes: push-keyed records, server-stamped `time`,
 * NotFoundError from the service bubbling to the global 404 handler.
 */
const gspReadingsRoutes: FastifyPluginAsyncZod = async (app) => {
  const rtdb = new RtdbService(app.firebase.database);

  app.addHook('preHandler', app.authenticate);

  // GET /api/gsp-readings
  app.get(
    '/gsp-readings',
    {
      schema: {
        response: {
          200: z.array(gspReadingSchema),
        },
      },
    },
    async (request) => {
      return rtdb.listGspReadings(request.uid);
    },
  );

  // POST /api/gsp-readings
  app.post(
    '/gsp-readings',
    {
      schema: {
        body: createGspReadingInputSchema,
        response: {
          201: gspReadingSchema,
        },
      },
    },
    async (request, reply) => {
      const reading = await rtdb.createGspReading(request.uid, request.body);
      return reply.code(201).send(reading);
    },
  );

  // PATCH /api/gsp-readings/:id
  app.patch(
    '/gsp-readings/:id',
    {
      schema: {
        params: readingIdParamsSchema,
        body: updateGspReadingInputSchema,
        response: {
          200: gspReadingSchema,
        },
      },
    },
    async (request) => {
      return rtdb.updateGspReading(request.uid, request.params.id, request.body);
    },
  );

  // DELETE /api/gsp-readings/:id
  app.delete(
    '/gsp-readings/:id',
    {
      schema: {
        params: readingIdParamsSchema,
        response: {
          204: z.undefined(),
        },
      },
    },
    async (request, reply) => {
      await rtdb.deleteGspReading(request.uid, request.params.id);
      return reply.code(204).send();
    },
  );
};

export default gspReadingsRoutes;
