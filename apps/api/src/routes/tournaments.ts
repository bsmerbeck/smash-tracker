import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { FastifyRequest } from 'fastify';
import {
  manualTournamentEntryInputSchema,
  tournamentEntryListSchema,
  tournamentEntrySchema,
  type TournamentEntry,
} from '@smash-tracker/shared';
import { reconcilePlayerActivation } from '../onboarding/activation.js';

// eslint-disable-next-line no-control-regex -- control chars are exactly what RTDB keys forbid
const RTDB_ILLEGAL = /[.#$[\]/\u0000-\u001f\u007f]/g;

/** `X-Session-Id` header, mirroring `matches.ts`'s identically-named helper — defaults to `'unknown'` when absent (never blocks the request). */
function sessionIdFromHeader(request: FastifyRequest): string {
  const header = request.headers['x-session-id'];
  const value = Array.isArray(header) ? header[0] : header;
  return value ?? 'unknown';
}

/**
 * Derives a sanitized, human-debuggable `entryKey` for a manual tournament
 * entry: the user's label, lowercased/slugified and stripped of RTDB-illegal
 * characters, with a random suffix for uniqueness (labels aren't unique —
 * two "Locals #42" entries must not collide). Mirrors the sanitization
 * regex already used by startgg/sync.ts and parrygg/sync.ts.
 */
function deriveManualEntryKey(eventName: string): string {
  const cleaned = eventName.trim().toLowerCase().replace(/\s+/g, '-').replace(RTDB_ILLEGAL, '');
  const base = cleaned.length > 0 ? cleaned : 'event';
  return `manual-${base}-${randomUUID().slice(0, 8)}`;
}

/**
 * GET /api/tournaments — the signed-in user's tournament registry, serving
 * start.gg (accumulated by startgg/sync.ts's `accumulateRegistry`),
 * parry.gg (accumulated by parrygg/sync.ts's `accumulateParryggRegistry`),
 * and manual (Phase 13, `POST /tournaments/manual-entry` below) entries,
 * each keyed by `entryKey`. Sync entries are written exclusively by the two
 * sync services; manual entries are written directly by this route, all
 * under tournamentEntries/{uid}/{entryKey}.
 */
const tournamentsRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.authenticate);

  app.get(
    '/tournaments',
    {
      schema: {
        response: {
          200: tournamentEntryListSchema,
        },
      },
    },
    async (request) => {
      const snapshot = await app.firebase.database.ref(`tournamentEntries/${request.uid}`).get();
      if (!snapshot.exists()) {
        return [];
      }
      const raw = snapshot.val() as Record<string, unknown>;
      // Always stamp entryKey from the RTDB child key — legacy start.gg
      // records (child key = String(eventId)) get a routable entryKey with
      // zero data migration; parry.gg entries carry their own sanitized key.
      // safeParse-and-skip (production-gap rule, mirrors RtdbService's
      // listMatches, review WR-03): one corrupt record must never 500 the
      // whole list — this tree now has TWO sync writers (start.gg +
      // parry.gg), and a single bad write would brick both the Trends table
      // and the recap entry point for that user. Skips log the child key +
      // failing field paths (never values, never uid) so corrupt data stays
      // discoverable in Cloud Run logs.
      const entries = Object.entries(raw).flatMap(([childKey, entry]) => {
        const parsed = tournamentEntrySchema.safeParse({
          ...(entry as object),
          entryKey: childKey,
        });
        if (!parsed.success) {
          request.log.warn(
            `tournaments: skipping corrupt entry ${childKey}: ${parsed.error.issues
              .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.code}`)
              .join('; ')}`,
          );
          return [];
        }
        return [parsed.data];
      });
      entries.sort((a, b) => b.lastSetAt - a.lastSetAt);
      return entries;
    },
  );

  // POST /api/tournaments/manual-entry — Phase 13 (ONBD-04, D-05 prep-path
  // integration-failure recovery): when start.gg/parry.gg sync isn't linked
  // or fails, the user can still record an event to prepare for. Writes a
  // minimal tournamentEntries/{uid}/{entryKey} record that GET /tournaments
  // already reads (no read-path change needed), then reconciles
  // tournament_prep_activated — this manual write IS the durable transition
  // (13-RESEARCH.md: there is no other manual "link an event" path today).
  // Always writes under request.uid — no target uid is ever accepted from
  // the client (T-13-05-01).
  app.post(
    '/tournaments/manual-entry',
    {
      schema: {
        body: manualTournamentEntryInputSchema,
        response: {
          201: tournamentEntrySchema,
        },
      },
    },
    async (request, reply) => {
      const eventDate = request.body.eventDate ?? Date.now();
      const entryKey = deriveManualEntryKey(request.body.eventName);
      const entry: TournamentEntry = {
        eventName: request.body.eventName,
        firstSetAt: eventDate,
        lastSetAt: eventDate,
        setsPlayed: 0,
        source: 'manual',
        entryKey,
      };
      await app.firebase.database.ref(`tournamentEntries/${request.uid}/${entryKey}`).set(entry);
      void reconcilePlayerActivation(
        app.firebase.database,
        request.uid,
        sessionIdFromHeader(request),
      );
      return reply.code(201).send(entry);
    },
  );
};

export default tournamentsRoutes;
