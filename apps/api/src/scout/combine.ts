import { mergeScoutReports, type ScoutReportData, type ScoutSource } from '@smash-tracker/shared';
import type { ParryggConfig, StartggConfig } from '../config/env.js';
import type { ParryggClients } from '../parrygg/client.js';
import { ParryScoutCache, scoutParryPlayer } from '../parrygg/scout.js';
import { StartggApiError } from '../startgg/client.js';
import { parseScoutInput, ScoutCache, ScoutInputError, scoutPlayer } from '../startgg/scout.js';

/**
 * V13 — "combine start.gg + parry.gg" scouting.
 *
 * `resolveCombinedScout` scouts a player across BOTH sites (two lookups the
 * caller has asserted are the same person) and merges the results into one
 * combined `ScoutReportData`. It reuses the existing per-source scout functions
 * (`scoutPlayer` / `scoutParryPlayer`) and their in-memory caches verbatim —
 * this is purely orchestration on top, no new external calls.
 *
 * Design decision (locked with the product owner): **succeed with whatever
 * resolves**. If only one side is found — because the other site has no such
 * player, the handle was malformed, or that source isn't configured on this
 * deployment — the single-source report is returned unchanged (still flagged by
 * its own `player.source`). `notFound` is only returned when NEITHER side
 * yields a report; `rateLimited` is preferred over `notFound` when a side was
 * rate-limited and no side succeeded (it's the retryable signal).
 */

export interface ScoutLookup {
  query: string;
  source: ScoutSource;
}

export interface CombinedScoutDeps {
  startggConfig: StartggConfig | null;
  parryggConfig: ParryggConfig | null;
  fetchImpl: typeof fetch;
  parryggClients?: ParryggClients;
  scoutCache: ScoutCache;
  parryScoutCache: ParryScoutCache;
}

export type CombinedScoutResult =
  { ok: true; report: ScoutReportData } | { ok: false; kind: 'notFound' | 'rateLimited' };

type SingleScoutOutcome =
  { status: 'ok'; report: ScoutReportData } | { status: 'notFound' } | { status: 'rateLimited' };

/**
 * Scouts ONE lookup. Never throws for the "expected" ways a side can produce
 * nothing (source unconfigured, player not found, malformed start.gg query,
 * start.gg rate limit) — those collapse to `notFound`/`rateLimited` so the
 * other side can still carry the combine. Genuinely unexpected errors still
 * propagate.
 */
async function scoutOne(lookup: ScoutLookup, deps: CombinedScoutDeps): Promise<SingleScoutOutcome> {
  if (lookup.source === 'parrygg') {
    // Unconfigured source is treated as "not found" (graceful fallback), not a
    // 503 — the single-source routes keep their own explicit 503s untouched.
    if (!deps.parryggConfig) {
      return { status: 'notFound' };
    }
    const report = await scoutParryPlayer(
      deps.parryggConfig.apiKey,
      lookup.query,
      deps.parryScoutCache,
      deps.parryggClients,
    );
    return report ? { status: 'ok', report } : { status: 'notFound' };
  }

  if (!deps.startggConfig) {
    return { status: 'notFound' };
  }
  let input;
  try {
    input = parseScoutInput(lookup.query);
  } catch (err) {
    // A malformed start.gg handle on ONE side must not sink the whole combine.
    if (err instanceof ScoutInputError) {
      return { status: 'notFound' };
    }
    throw err;
  }
  try {
    const report = await scoutPlayer(
      deps.startggConfig.apiToken,
      input,
      deps.fetchImpl,
      deps.scoutCache,
    );
    return report ? { status: 'ok', report } : { status: 'notFound' };
  } catch (err) {
    if (err instanceof StartggApiError && err.status === 429) {
      return { status: 'rateLimited' };
    }
    throw err;
  }
}

/**
 * Resolves and merges the given lookups (the caller passes exactly two, one per
 * site). Runs both in parallel, then folds every side that produced a report:
 * 2 → merged, 1 → that single report unchanged, 0 → `notFound` (or
 * `rateLimited` if a side was rate-limited).
 */
export async function resolveCombinedScout(
  lookups: ScoutLookup[],
  deps: CombinedScoutDeps,
): Promise<CombinedScoutResult> {
  const outcomes = await Promise.all(lookups.map((lookup) => scoutOne(lookup, deps)));
  const reports = outcomes.flatMap((outcome) => (outcome.status === 'ok' ? [outcome.report] : []));

  // The domain is exactly two sites, so there are at most two reports here.
  const [first, second] = reports;
  if (first && second) {
    return { ok: true, report: mergeScoutReports(first, second) };
  }
  if (first) {
    return { ok: true, report: first };
  }
  if (outcomes.some((outcome) => outcome.status === 'rateLimited')) {
    return { ok: false, kind: 'rateLimited' };
  }
  return { ok: false, kind: 'notFound' };
}
