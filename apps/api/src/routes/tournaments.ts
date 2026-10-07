import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { FastifyRequest } from 'fastify';
import type { Reference } from 'firebase-admin/database';
import {
  entryKeyInputSchema,
  manualTournamentEntryInputSchema,
  RULESET_CONTRACT_VERSION,
  rulesetOverrideResponseSchema,
  rulesetOverrideUpdateBodySchema,
  TIER_OVERRIDE_CONTRACT_VERSION,
  tierOverrideResponseSchema,
  tierOverrideUpdateBodySchema,
  TOURNAMENT_REGISTRY_ORIGIN,
  tournamentEntrySchema,
  tournamentRegistryListSchema,
  tournamentRegistryRowSchema,
  type RulesetOverrideStored,
  type TierOverrideStored,
  type TournamentEntry,
  type TournamentRegistryListEntry,
} from '@smash-tracker/shared';
import { reconcilePlayerActivation } from '../onboarding/activation.js';
import { NotFoundError } from '../services/rtdb.js';
import {
  withoutUnreadableOverrides,
  type UserOwnedOverrideMember,
} from '../services/tournamentOverrides.js';

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
 * Sets one override member on an EXISTING entry: the existence check and the
 * write are one transaction on the entry (39.2 code review API-IN-05). A
 * separate `get()` then `update()` let an entry removed in between (a
 * reconcile orphan removal, for one) come back as an override-only stub that
 * GET skips as corrupt and reconcile reports as a foreign collision forever.
 *
 * Null-first-safe: the SDK's first run sees `null` and returns `null` (a
 * no-op delete), which only commits when the node is truly absent; when it
 * exists the SDK re-runs with the stored value and the member is replaced
 * wholesale.
 */
async function writeOverrideIfEntryExists(
  entryRef: Reference,
  entryKey: string,
  member: { tierOverride: TierOverrideStored } | { rulesetOverride: RulesetOverrideStored },
): Promise<void> {
  let found = false;
  await entryRef.transaction((current: unknown) => {
    // Reset per run: only the run that commits decides the outcome.
    found = false;
    if (current === null || current === undefined) {
      return null; // absent — nothing to write onto
    }
    if (typeof current !== 'object' || Array.isArray(current)) {
      return undefined; // not an entry — abort, never overwrite
    }
    found = true;
    return { ...(current as Record<string, unknown>), ...member };
  });
  if (!found) {
    throw new NotFoundError(`Tournament entry ${entryKey} not found`);
  }
}

/**
 * Clears one override member of an EXISTING entry, as a transaction on the
 * entry (39.2 code review R2-WR-01). Every writer of an entry is a
 * transaction on the entry path, so writers queue behind each other: in the
 * Firebase SDK a plain `set`/`remove` from this process aborts every queued
 * transaction at its path, ancestors and descendants — a child `.remove()`
 * here made an in-flight sync commit, or an in-flight override set, reject
 * with `Error('set')`. It also replaces a separate `get()` existence check,
 * which could read an in-flight transaction's optimistic `null` guess and
 * answer 404 for an entry that exists.
 *
 * Null-first-safe like `writeOverrideIfEntryExists`: the first run's `null`
 * is a no-op delete that only commits when the node is truly absent, and the
 * member is dropped from the value stored at commit time, never written as a
 * null (RTDB null-stripping house rule).
 */
async function clearOverrideIfEntryExists(
  entryRef: Reference,
  entryKey: string,
  member: UserOwnedOverrideMember,
): Promise<void> {
  let found = false;
  await entryRef.transaction((current: unknown) => {
    // Reset per run: only the run that commits decides the outcome.
    found = false;
    if (current === null || current === undefined) {
      return null; // absent — nothing to clear
    }
    if (typeof current !== 'object' || Array.isArray(current)) {
      return undefined; // not an entry — abort, never overwrite
    }
    found = true;
    const rest: Record<string, unknown> = { ...(current as Record<string, unknown>) };
    delete rest[member];
    return rest;
  });
  if (!found) {
    throw new NotFoundError(`Tournament entry ${entryKey} not found`);
  }
}

/**
 * GET /api/tournaments — the signed-in user's tournament registry, serving
 * start.gg (accumulated by startgg/sync.ts's `accumulateRegistry`),
 * parry.gg (accumulated by parrygg/sync.ts's `accumulateParryggRegistry`),
 * manual (Phase 13, `POST /tournaments/manual-entry` below), and — Phase
 * 30.3 — admin-imported historical rows (written only by the
 * research-registry projector, `apps/api/src/research/registry/`), each
 * keyed by `entryKey`. Sync entries are written exclusively by the two
 * sync services; manual entries are written directly by this route, all
 * under tournamentEntries/{uid}/{entryKey}.
 *
 * Phase 30.3 response extension is BACKWARDS-COMPATIBLE by construction:
 * legacy entries keep their exact shape, and an admin-imported row is a
 * strict superset of `tournamentEntrySchema` (it carries the legacy
 * required members), so an old client parsing the list with the legacy
 * schema still succeeds — the registry-only members are simply stripped.
 * New clients discriminate on `origin === 'admin-imported'`; those rows
 * are always PAST events (their `firstSetAt` is historical or 0), so the
 * shipped upcoming-event prep gate (`firstSetAt > now`) never offers
 * registration/seeded/live prep controls for one, and the explicit origin
 * field lets the web separate them from linked-sync entries outright.
 */
const tournamentsRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('preHandler', app.authenticate);

  app.get(
    '/tournaments',
    {
      schema: {
        response: {
          200: tournamentRegistryListSchema,
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
      const entries = Object.entries(raw).flatMap<TournamentRegistryListEntry>(
        ([childKey, entry]) => {
          // Phase 30.3: discriminate on the stored origin member BEFORE
          // choosing a parser — a registry row would also pass the legacy
          // schema (which would strip origin/provenance), so the raw
          // discriminator, not schema fallback order, picks the shape.
          const isRegistryRow =
            entry !== null &&
            typeof entry === 'object' &&
            (entry as Record<string, unknown>).origin === TOURNAMENT_REGISTRY_ORIGIN;
          // 39.2 code review API-WR-02: an override member this build cannot
          // read is treated as absent instead of failing the whole row, so
          // the event stays listed and its page can replace or clear it.
          const { row, omitted } = withoutUnreadableOverrides(entry);
          for (const { member, status } of omitted) {
            request.log.warn(
              `tournaments: ignoring an unreadable ${member} on entry ${childKey} (${status})`,
            );
          }
          const parsed = (
            isRegistryRow ? tournamentRegistryRowSchema : tournamentEntrySchema
          ).safeParse({
            ...(row as object),
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
        },
      );
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
      // Phase 28 (REV-01, 28-05): `eventEndDate` is local-calendar-midnight
      // of the event's LAST day (multi-day events). `lastSetAt` is what
      // `deriveReviewAtCandidate`'s manual branch (+24h) and
      // `matchesForEntry`'s window read, so storing it here — instead of
      // `eventDate` alone — makes a multi-day event convert to review after
      // its FINAL day and widens its ±24h match window to cover every day.
      // No-end-date path is unchanged: `eventDate` (a single value) still
      // flows into both `firstSetAt` and `lastSetAt`.
      const entry: TournamentEntry = {
        eventName: request.body.eventName,
        firstSetAt: eventDate,
        lastSetAt: request.body.eventEndDate ?? eventDate,
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

  // PATCH /api/tournaments/:entryKey/ruleset — EVID-04 (37-CONTEXT.md D-10):
  // set or clear the per-event ruleset override. Modeled on gspReadings.ts's
  // own-uid PATCH route: the RTDB path is assembled from `request.uid` ONLY
  // — no target uid is ever accepted from the client — so a foreign or
  // unknown entryKey is indistinguishable from one that doesn't exist
  // (both answer the same not-found error). D-18 (this phase, own-account
  // only): Tournaments has no coach mount today, and this route does not add
  // subject/tenant-membership resolution — a client's own tournament entry
  // is editable by that client alone this phase; Phase 38 owns any future
  // coach mount for this surface.
  app.patch(
    '/tournaments/:entryKey/ruleset',
    {
      schema: {
        params: z.object({ entryKey: entryKeyInputSchema }),
        body: rulesetOverrideUpdateBodySchema,
        response: {
          200: rulesetOverrideResponseSchema,
        },
      },
    },
    async (request) => {
      const { entryKey } = request.params;
      const entryRef = app.firebase.database.ref(`tournamentEntries/${request.uid}/${entryKey}`);
      const { rulesetOverride } = request.body;

      if (rulesetOverride === null) {
        // Clearing drops the member from the stored entry rather than writing
        // a null into an update payload — the exact pattern this codebase's
        // documented `260725-juj` outage was caused by omitting — inside a
        // transaction on the entry, so it never aborts a sync commit (R2-WR-01).
        await clearOverrideIfEntryExists(entryRef, entryKey, 'rulesetOverride');
        return { entryKey };
      }

      // Every optional member is conditional-spread so a member the caller
      // omitted is OMITTED from the write, never stored as an empty value.
      // `contractVersion` is always stamped from the server's own running
      // constant — never trusted from the client body — so a stale or
      // future contractVersion in the request can never be persisted as the
      // stored value.
      const stored: RulesetOverrideStored = {
        contractVersion: RULESET_CONTRACT_VERSION,
        ...(rulesetOverride.starterStageIds != null
          ? { starterStageIds: rulesetOverride.starterStageIds }
          : {}),
        ...(rulesetOverride.counterpickStageIds != null
          ? { counterpickStageIds: rulesetOverride.counterpickStageIds }
          : {}),
        ...(rulesetOverride.banCounts != null ? { banCounts: rulesetOverride.banCounts } : {}),
        ...(rulesetOverride.dsr != null ? { dsr: rulesetOverride.dsr } : {}),
        ...(rulesetOverride.strikeOrder != null
          ? { strikeOrder: rulesetOverride.strikeOrder }
          : {}),
        ...(rulesetOverride.setFormat != null ? { setFormat: rulesetOverride.setFormat } : {}),
      };
      // Replaces the member wholesale, so a member the editor dropped this
      // time does not linger from a previous write; the existence check and
      // the write are one transaction (API-IN-05).
      await writeOverrideIfEntryExists(entryRef, entryKey, { rulesetOverride: stored });
      return { entryKey, rulesetOverride: stored };
    },
  );

  // PATCH /api/tournaments/:entryKey/tier — Phase 39.2 (TIER-04, D-15): set
  // or clear the per-event manual tier override. Mirrors the ruleset route
  // above: the RTDB path is assembled from `request.uid` ONLY (own-uid by
  // D-17 — the owner deferred a real coach tier path, so this plugin
  // registers no subject resolution), which makes a foreign entry key
  // indistinguishable from a missing one (the same 404).
  //
  // WR-02 ("saving never freezes untouched members") holds here because the
  // override has exactly ONE user-editable member (`tier`): the write
  // replaces only the `tierOverride` member, and the transaction re-writes
  // every sibling with the value stored at commit time, so none is changed.
  // Any future member (for example a reason note)
  // must adopt `RulesetOverrideSection`'s baseline-diff payload before it
  // ships. The resolved tier, basis and estimate are read-time only and are
  // never written (TIER-01).
  app.patch(
    '/tournaments/:entryKey/tier',
    {
      schema: {
        params: z.object({ entryKey: entryKeyInputSchema }),
        body: tierOverrideUpdateBodySchema,
        response: {
          200: tierOverrideResponseSchema,
        },
      },
    },
    async (request) => {
      const { entryKey } = request.params;
      const entryRef = app.firebase.database.ref(`tournamentEntries/${request.uid}/${entryKey}`);
      const { tierOverride } = request.body;

      if (tierOverride === null) {
        // The member is dropped, never a null inside an update payload (RTDB
        // null-stripping house rule), in a transaction on the entry (R2-WR-01).
        await clearOverrideIfEntryExists(entryRef, entryKey, 'tierOverride');
        return { entryKey };
      }

      // Version and timestamp are stamped by the server; the body schema
      // does not even carry them, so a smuggled value never reaches storage.
      const stored: TierOverrideStored = {
        contractVersion: TIER_OVERRIDE_CONTRACT_VERSION,
        tier: tierOverride.tier,
        setAtMs: Date.now(),
      };
      await writeOverrideIfEntryExists(entryRef, entryKey, { tierOverride: stored });
      return { entryKey, tierOverride: stored };
    },
  );
};

export default tournamentsRoutes;
