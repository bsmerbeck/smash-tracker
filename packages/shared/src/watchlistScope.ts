import type { Match } from './match.js';
import { resolveOpponentIdentities } from './evidence/opponentEvidence.js';
import { stageBucketId } from './evidence/predicate.js';
import type { InsightScope } from './insight/types.js';
import type { WatchlistItem } from './watchlist.js';

// Kept apart from `watchlist.ts` on purpose: the web's eager `api.ts` imports
// the watchlist wire schemas from `watchlist.ts`, and Rolldown keeps every used
// export of a module in one chunk. When this function lived there, its
// evidence-engine imports (opponentEvidence, predicate, identity, fighterData…)
// rode the eager `api` chunk (+15.7 KB, 39.2-11). Here they stay lazy.

/**
 * The `InsightScope` an item's form is read through — the scope the digest's
 * `formNow` read and the Tracked row share. Each `filter` selects exactly what
 * the page hosting that item's Track toggle selects:
 * - opponent: the opponent hub's technique — `resolveOpponentIdentities` over
 *   the matches with the alias map, keeping matches whose resolved identity
 *   is the tag's (`OpponentHubPage.tsx`); `opponentAliases` are the alias
 *   names that fold into this canonical tag.
 * - matchup: the Matchups pairing filter, `fighter_id === f && opponent_id === v`.
 * - stage: the stage detail page's bucket, `stageBucketId(match) === stageId`
 *   (an absent `map` is the unknown-stage bucket, never a tracked stage).
 * Plan 39.2-11 adds the web-side equality test against the pages' own filters.
 */
export function trackedItemScope(
  item: WatchlistItem,
  options?: { opponentAliases?: readonly string[] },
): InsightScope {
  switch (item.kind) {
    case 'opponent': {
      const tag = item.ref;
      const aliases = options?.opponentAliases ?? [];
      return {
        kind: 'player',
        key: `player:${tag}`,
        axes: { opponent: tag },
        filter: (matches: Match[]): Match[] => {
          const aliasMap: Record<string, string> = {};
          for (const alias of aliases) {
            const normalized = alias.trim().toLowerCase();
            if (normalized.length > 0 && normalized !== tag) {
              aliasMap[normalized] = tag;
            }
          }
          const resolve = resolveOpponentIdentities(matches, aliasMap);
          const target = resolve({ opponent: tag });
          return matches.filter((match) => resolve(match) === target);
        },
      };
    }
    case 'matchup': {
      const { fighterId, vsFighterId } = item.ref;
      return {
        kind: 'character',
        key: `matchup:${fighterId}-${vsFighterId}`,
        axes: { fighter: fighterId, vs: vsFighterId },
        filter: (matches: Match[]): Match[] =>
          matches.filter(
            (match) => match.fighter_id === fighterId && match.opponent_id === vsFighterId,
          ),
      };
    }
    case 'stage': {
      const stageId = item.ref;
      return {
        kind: 'stage',
        key: `stage:${stageId}`,
        axes: { stage: stageId },
        filter: (matches: Match[]): Match[] =>
          matches.filter((match) => stageBucketId(match) === stageId),
      };
    }
  }
}
