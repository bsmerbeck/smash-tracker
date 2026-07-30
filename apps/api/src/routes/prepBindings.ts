import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  entryKeyInputSchema,
  errorResponseSchema,
  matchRecordSchema,
  opponentAliasMapSchema,
  opponentNameInputSchema,
  PREP_LIKELY_OPPONENTS_MAX,
  prepBriefResponseSchema,
  prepScoutBindingCandidatesResponseSchema,
  prepScoutBindingConfirmRequestSchema,
  type PrepScoutBindingCandidate,
  type ScoutBinding,
  type ScoutBindingProvider,
} from '@smash-tracker/shared';
import type { ParryggConfig, StartggConfig } from '../config/env.js';
import type { ParryggClients } from '../parrygg/client.js';
import { parseScoutInput, ScoutCache, ScoutInputError, scoutPlayer } from '../startgg/scout.js';
import { ParryScoutCache, scoutParryPlayer } from '../parrygg/scout.js';
import { normalizeOpponentTag } from '../startgg/sync.js';
import { clearPrepScoutBinding, readPrepBrief, setPrepScoutBinding } from '../prep/prep.js';
import { NotFoundError } from '../services/rtdb.js';

/**
 * `apps/api/src/routes/prepBindings.ts` is a SIBLING of `routes/prep.ts` —
 * deliberately NOT inside `apps/api/src/prep/` — because binding resolution
 * needs the start.gg and parry.gg scout resolvers, and the prep module's
 * import-graph gate plus its stated "zero model calls, zero credit
 * movement" ownership (D-22, `importGraph.test.ts`) must stay narrow.
 * Nothing in this file spends a credit, creates a report job, or calls the
 * model — it only performs read-only provider lookups (start.gg GraphQL /
 * parry.gg gRPC) and then delegates the actual storage write to
 * `setPrepScoutBinding`/`clearPrepScoutBinding` in `apps/api/src/prep/prep.ts`.
 */

/** Small module cap on the candidate list — never larger than the curated-opponent ceiling itself (T-27-28). */
const MAX_BINDING_CANDIDATES = PREP_LIKELY_OPPONENTS_MAX;

/** Deterministic provider ordering for the candidate sort — index-based, not alphabetical, so it never silently depends on string comparison of the enum values. */
const CANDIDATE_PROVIDER_ORDER: Record<'startgg' | 'parrygg', number> = {
  startgg: 0,
  parrygg: 1,
};

export interface PrepBindingsRoutesOptions {
  startggConfig: StartggConfig | null;
  parryggConfig: ParryggConfig | null;
  /** Overridable fetch for the start.gg GraphQL calls (tests). */
  fetchImpl?: typeof fetch;
  /** Overridable parry.gg gRPC-Web service clients (tests). */
  parryggClients?: ParryggClients;
}

const prepBindingParamsSchema = z.object({
  entryKey: entryKeyInputSchema,
  name: opponentNameInputSchema,
});

interface CandidateAccumulator {
  provider: 'startgg' | 'parrygg';
  startggUserSlug?: string;
  parryUserId?: string;
  matchCount: number;
  displayTag: string;
}

/**
 * Groups the caller's OWN alias-resolved stored matches for one curated
 * canonical opponent name into candidate identities — never auto-selected,
 * never sorted by frequency or recency (27-CONTEXT.md line 91, T-27-28
 * companion rule). A match contributes to a candidate ONLY when it carries
 * at least one provider identity field; a bare tag alone is never a
 * candidate (T-27-27).
 */
function groupBindingCandidates(
  rawMatches: Array<ReturnType<typeof matchRecordSchema.parse>>,
  aliasMap: Record<string, string>,
  canonicalName: string,
): PrepScoutBindingCandidate[] {
  function canonicalOpponentName(tag: string | undefined): string {
    const normalized = normalizeOpponentTag(tag);
    return aliasMap[normalized] ?? normalized;
  }

  const candidatesByKey = new Map<string, CandidateAccumulator>();

  function accumulate(
    key: string,
    provider: 'startgg' | 'parrygg',
    identity: { startggUserSlug?: string; parryUserId?: string },
    rawTag: string | undefined,
  ): void {
    const existing = candidatesByKey.get(key);
    const observedTag = (rawTag ?? '').trim();
    if (existing) {
      existing.matchCount += 1;
      if (observedTag.length > existing.displayTag.length) {
        existing.displayTag = observedTag;
      }
      return;
    }
    candidatesByKey.set(key, {
      provider,
      ...identity,
      matchCount: 1,
      displayTag: observedTag,
    });
  }

  for (const match of rawMatches) {
    if (canonicalOpponentName(match.opponent) !== canonicalName) {
      continue;
    }
    if (match.opponentUserSlug) {
      accumulate(
        `startgg:${match.opponentUserSlug}`,
        'startgg',
        { startggUserSlug: match.opponentUserSlug },
        match.opponent,
      );
    }
    if (match.opponentParryUserId) {
      accumulate(
        `parrygg:${match.opponentParryUserId}`,
        'parrygg',
        { parryUserId: match.opponentParryUserId },
        match.opponent,
      );
    }
  }

  // Deterministic, identity-based sort — explicitly NOT by matchCount or
  // recency, so the UI can never present a "most likely" answer the owner's
  // rules forbid (27-CONTEXT.md line 91).
  return [...candidatesByKey.entries()]
    .sort(([keyA, valueA], [keyB, valueB]) => {
      const providerDelta =
        CANDIDATE_PROVIDER_ORDER[valueA.provider] - CANDIDATE_PROVIDER_ORDER[valueB.provider];
      if (providerDelta !== 0) {
        return providerDelta;
      }
      return keyA.localeCompare(keyB);
    })
    .slice(0, MAX_BINDING_CANDIDATES)
    .map(([, value]) => ({
      provider: value.provider,
      ...(value.startggUserSlug ? { startggUserSlug: value.startggUserSlug } : {}),
      ...(value.parryUserId ? { parryUserId: value.parryUserId } : {}),
      displayTag: value.displayTag.length > 0 ? value.displayTag : 'Unknown',
      matchCount: value.matchCount,
    }));
}

/**
 * Phase 27 (RPT-01/RPT-02, 27-06): candidate listing, confirm, and clear for
 * a curated opponent's scoutBinding. Personal-only, uid-only addressing —
 * no coach-workspace subject switching helper is used anywhere in this
 * file, mirroring `routes/prep.ts`'s own rule and rationale (T-27-24) —
 * every handler reads `request.uid` directly.
 */
const prepBindingsRoutes: FastifyPluginAsyncZod<PrepBindingsRoutesOptions> = async (
  app,
  options,
) => {
  app.addHook('preHandler', app.authenticate);

  const fetchImpl = options.fetchImpl ?? fetch;
  const scoutCache = new ScoutCache();
  const parryScoutCache = new ParryScoutCache();

  // GET /api/prep/:entryKey/opponents/:name/binding-candidates — a pure
  // read: zero writes, zero charge, zero model call (T-27-26). A name not
  // currently curated on the brief answers an EMPTY list rather than a 404
  // — the client may race a de-selection, and an empty list is the honest
  // answer that leaks nothing about the caller's wider match history.
  app.get(
    '/prep/:entryKey/opponents/:name/binding-candidates',
    {
      schema: {
        params: prepBindingParamsSchema,
        response: {
          200: prepScoutBindingCandidatesResponseSchema,
        },
      },
    },
    async (request) => {
      const { entryKey, name } = request.params;
      const brief = await readPrepBrief(app.firebase.database, request.uid, entryKey);
      if (brief === null) {
        throw new NotFoundError(`Prep brief not found for entryKey ${entryKey}`);
      }
      if (!(name in brief.likelyOpponents)) {
        return { candidates: [] };
      }

      const [matchesSnapshot, aliasSnapshot] = await Promise.all([
        app.firebase.database.ref(`matches/${request.uid}`).get(),
        app.firebase.database.ref(`opponentAliases/${request.uid}`).get(),
      ]);

      const aliasMap = aliasSnapshot.exists()
        ? opponentAliasMapSchema.parse(aliasSnapshot.val())
        : ({} as Record<string, string>);

      const rawMatches = matchesSnapshot.exists()
        ? Object.values(matchesSnapshot.val() as Record<string, unknown>).map((value) =>
            matchRecordSchema.parse(value),
          )
        : [];

      return { candidates: groupBindingCandidates(rawMatches, aliasMap, name) };
    },
  );

  // PUT /api/prep/:entryKey/opponents/:name/binding — confirm a binding.
  // The request body carries REFERENCES (opaque provider queries), NOT
  // identities: whatever the client sent is discarded once resolution
  // succeeds, and only the resolver's OWN output is persisted (T-27-23).
  // The start.gg side structurally refuses a bare gamer tag
  // (`parseScoutInput` only accepts a profile URL, a "user/<slug>"
  // reference, or a numeric player id) — this is the guarantee that a bare
  // tag can never become a binding (27-CONTEXT.md line 93, T-27-27).
  app.put(
    '/prep/:entryKey/opponents/:name/binding',
    {
      schema: {
        params: prepBindingParamsSchema,
        body: prepScoutBindingConfirmRequestSchema,
        response: {
          200: prepBriefResponseSchema,
          400: errorResponseSchema,
          404: errorResponseSchema,
          503: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { entryKey, name } = request.params;
      const { startgg, parrygg } = request.body;

      // Owner walkthrough finding (2026-07-30): the client submits an
      // ambiguous pasted reference under BOTH provider branches (client-side
      // provider parsing is forbidden by 27-CONTEXT.md). Failing fast on the
      // first branch made a valid parry.gg link unresolvable whenever
      // start.gg was unconfigured or refused the input. When both branches
      // carry the SAME opaque reference (the manual-paste shape), each
      // provider's failure is recorded and the OTHER provider still gets its
      // chance — the request fails only when neither resolves. Both branches
      // with DIFFERENT references is the deliberate combined-candidate
      // confirmation (explicit same-person identities) and keeps fail-fast
      // errors, as do single-branch candidate confirmations.
      const ambiguous = Boolean(startgg && parrygg && startgg.query === parrygg.query);
      type BranchFailure = { statusCode: 400 | 404 | 503; error: string; message: string };
      let startggFailure: BranchFailure | undefined;
      let parryFailure: BranchFailure | undefined;

      let startggResolved:
        { startggPlayerId: number; startggUserSlug?: string; gamerTag: string } | undefined;
      if (startgg) {
        if (!options.startggConfig) {
          startggFailure = {
            error: 'Service Unavailable',
            message: 'start.gg integration is not configured on this server',
            statusCode: 503,
          };
        } else {
          let input;
          try {
            input = parseScoutInput(startgg.query);
          } catch (err) {
            if (err instanceof ScoutInputError) {
              startggFailure = {
                error: 'Bad Request',
                message: err.message,
                statusCode: 400,
              };
            } else if (ambiguous) {
              startggFailure = {
                error: 'Service Unavailable',
                message: 'start.gg lookup failed',
                statusCode: 503,
              };
            } else {
              throw err;
            }
          }

          if (input !== undefined) {
            let report;
            try {
              report = await scoutPlayer(
                options.startggConfig.apiToken,
                input,
                fetchImpl,
                scoutCache,
              );
            } catch (err) {
              // In ambiguous mode a provider outage must not block the
              // other provider's resolution attempt.
              if (!ambiguous) {
                throw err;
              }
              startggFailure = {
                error: 'Service Unavailable',
                message: 'start.gg lookup failed',
                statusCode: 503,
              };
            }
            if (!startggFailure) {
              if (!report || report.player.id === undefined) {
                startggFailure = {
                  error: 'Not Found',
                  message: 'No start.gg player found for that query',
                  statusCode: 404,
                };
              } else {
                startggResolved = {
                  startggPlayerId: report.player.id,
                  ...(report.player.userSlug ? { startggUserSlug: report.player.userSlug } : {}),
                  gamerTag: report.player.gamerTag,
                };
              }
            }
          }
        }
        if (startggFailure && !ambiguous) {
          return reply.code(startggFailure.statusCode).send(startggFailure);
        }
      }

      let parryResolved: { parryUserId: string; gamerTag: string } | undefined;
      if (parrygg) {
        if (!options.parryggConfig) {
          parryFailure = {
            error: 'Service Unavailable',
            message: 'parry.gg integration is not configured on this server',
            statusCode: 503,
          };
        } else {
          let report;
          try {
            report = await scoutParryPlayer(
              options.parryggConfig.apiKey,
              parrygg.query,
              parryScoutCache,
              options.parryggClients,
            );
          } catch (err) {
            if (!ambiguous) {
              throw err;
            }
            parryFailure = {
              error: 'Service Unavailable',
              message: 'parry.gg lookup failed',
              statusCode: 503,
            };
          }
          // A resolution that produced no player, or produced one with no
          // stable parry.gg user id, is refused — only a resolution that
          // yields a stable provider id is accepted (T-27-27 parry.gg side).
          if (!parryFailure) {
            if (!report || !report.player.parryUserId) {
              parryFailure = {
                error: 'Not Found',
                message: 'No parry.gg player found for that query',
                statusCode: 404,
              };
            } else {
              parryResolved = {
                parryUserId: report.player.parryUserId,
                gamerTag: report.player.gamerTag,
              };
            }
          }
        }
        if (parryFailure && !ambiguous) {
          return reply.code(parryFailure.statusCode).send(parryFailure);
        }
      }

      if (!startggResolved && !parryResolved) {
        // Neither branch resolved. Both-unconfigured stays a 503; otherwise
        // a combined 404/400 that names both outcomes so the player can fix
        // their reference.
        if (startggFailure?.statusCode === 503 && parryFailure?.statusCode === 503) {
          return reply.code(503).send(startggFailure);
        }
        const details = [startggFailure?.message, parryFailure?.message].filter(Boolean).join('; ');
        return reply.code(404).send({
          error: 'Not Found',
          message: details || 'No player found for that reference on either provider',
          statusCode: 404,
        });
      }

      if (ambiguous && startggResolved && parryResolved) {
        // A single pasted reference resolving on BOTH providers cannot prove
        // the two accounts are the same person — the combined provider
        // requires explicit same-person confirmation (27-CONTEXT.md), which
        // means confirming each provider separately.
        return reply.code(400).send({
          error: 'Bad Request',
          message:
            'That reference matched players on both start.gg and parry.gg — confirm each provider separately',
          statusCode: 400,
        });
      }

      const provider: ScoutBindingProvider =
        startggResolved && parryResolved ? 'combined' : startggResolved ? 'startgg' : 'parrygg';
      // start.gg preferred as the display tag source when both resolved,
      // matching the plan's stated preference.
      const displayTag = startggResolved?.gamerTag ?? parryResolved?.gamerTag ?? '';

      const binding: ScoutBinding = {
        provider,
        ...(startggResolved
          ? {
              startggPlayerId: startggResolved.startggPlayerId,
              ...(startggResolved.startggUserSlug
                ? { startggUserSlug: startggResolved.startggUserSlug }
                : {}),
            }
          : {}),
        ...(parryResolved ? { parryUserId: parryResolved.parryUserId } : {}),
        displayTag,
        // The caller always supplied an explicit reference on this route —
        // even a pre-filled candidate is still an explicit confirmation —
        // so `method` is always 'profileInput' here.
        method: 'profileInput',
        confirmedAt: Date.now(),
      };

      // ConflictError (not-currently-curated)/NotFoundError (no brief) map
      // through the existing global handler — no local try/catch, matching
      // `routes/prep.ts`'s stated convention.
      const brief = await setPrepScoutBinding(
        app.firebase.database,
        request.uid,
        entryKey,
        name,
        binding,
      );
      return { brief };
    },
  );

  // DELETE /api/prep/:entryKey/opponents/:name/binding — clear a binding.
  app.delete(
    '/prep/:entryKey/opponents/:name/binding',
    {
      schema: {
        params: prepBindingParamsSchema,
        response: {
          200: prepBriefResponseSchema,
        },
      },
    },
    async (request) => {
      const { entryKey, name } = request.params;
      const brief = await clearPrepScoutBinding(app.firebase.database, request.uid, entryKey, name);
      return { brief };
    },
  );
};

export default prepBindingsRoutes;
