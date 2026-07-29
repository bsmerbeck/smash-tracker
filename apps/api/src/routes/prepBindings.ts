import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  entryKeyInputSchema,
  matchRecordSchema,
  opponentAliasMapSchema,
  opponentNameInputSchema,
  PREP_LIKELY_OPPONENTS_MAX,
  prepScoutBindingCandidatesResponseSchema,
  type PrepScoutBindingCandidate,
} from '@smash-tracker/shared';
import type { ParryggConfig, StartggConfig } from '../config/env.js';
import type { ParryggClients } from '../parrygg/client.js';
import { normalizeOpponentTag } from '../startgg/sync.js';
import { readPrepBrief } from '../prep/prep.js';
import { NotFoundError } from '../services/rtdb.js';

/**
 * `apps/api/src/routes/prepBindings.ts` is a SIBLING of `routes/prep.ts` —
 * deliberately NOT inside `apps/api/src/prep/` — because binding resolution
 * needs the start.gg and parry.gg scout resolvers (added in 27-06 Task 3),
 * and the prep module's import-graph gate plus its stated "zero model
 * calls, zero credit movement" ownership (D-22, `importGraph.test.ts`) must
 * stay narrow. Nothing in this file spends a credit, creates a report job,
 * or calls the model — Task 3 adds only read-only provider lookups
 * (start.gg GraphQL / parry.gg gRPC) and then delegates the actual storage
 * write to `setPrepScoutBinding`/`clearPrepScoutBinding` in
 * `apps/api/src/prep/prep.ts`.
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
const prepBindingsRoutes: FastifyPluginAsyncZod<PrepBindingsRoutesOptions> = async (app) => {
  app.addHook('preHandler', app.authenticate);

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
};

export default prepBindingsRoutes;
