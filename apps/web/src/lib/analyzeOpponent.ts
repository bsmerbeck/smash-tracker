import type { Match, OpponentAliasMap } from '@smash-tracker/shared';

/**
 * Phase 30.3 (Gate 4): "Analyze opponent" deep links. Every affordance
 * (Match Data opponent cells, tournament set rows, VOD selected-match card)
 * navigates into the EXISTING `/opponents` scouting surface with the
 * opponent preselected — identity is carried in the query string, provider
 * player ID first (`player=sgg:<userSlug>` / `player=pgg:<parryUserId>`),
 * with the alias-aware free-text tag (`opponent=<tag>`) as the only
 * fallback when no provider identity exists.
 */

export const ANALYZE_OPPONENT_PLAYER_PARAM = 'player';
export const ANALYZE_OPPONENT_TAG_PARAM = 'opponent';

const STARTGG_PREFIX = 'sgg:';
const PARRYGG_PREFIX = 'pgg:';

export interface AnalyzeOpponentIdentity {
  /** The human opponent's start.gg profile slug, when known. */
  opponentUserSlug?: string | undefined;
  /** The human opponent's parry.gg user id, when known. */
  opponentParryUserId?: string | undefined;
  /** The free-text opponent tag, when known. */
  opponent?: string | undefined;
}

/**
 * Builds the `/opponents` path (with search) for an identity, or `null`
 * when nothing identifies the opponent (anonymous quickplay rows get no
 * affordance rather than a dead link). The tag rides along even when a
 * provider ID exists so resolution can still succeed if the ID never
 * appears in the viewer's own match history.
 */
export function buildAnalyzeOpponentPath(identity: AnalyzeOpponentIdentity): string | null {
  const params = new URLSearchParams();
  if (identity.opponentUserSlug) {
    params.set(ANALYZE_OPPONENT_PLAYER_PARAM, `${STARTGG_PREFIX}${identity.opponentUserSlug}`);
  } else if (identity.opponentParryUserId) {
    params.set(ANALYZE_OPPONENT_PLAYER_PARAM, `${PARRYGG_PREFIX}${identity.opponentParryUserId}`);
  }
  if (identity.opponent) {
    params.set(ANALYZE_OPPONENT_TAG_PARAM, identity.opponent);
  }
  const search = params.toString();
  return search === '' ? null : `/opponents?${search}`;
}

/**
 * Resolves an `/opponents` deep link's search params to the canonical
 * opponent name to preselect, or `null` when the params identify nobody.
 *
 * - `player=sgg:<slug>` / `player=pgg:<id>`: scans `matches` (which callers
 *   pass ALREADY alias-canonicalized — `useFilteredMatches` output) for a
 *   row carrying that provider identity and returns its canonical name.
 *   Provider IDs are preferred because they survive tag changes and alias
 *   merges without any string matching.
 * - `opponent=<tag>` (fallback, or when the ID matched nothing): the tag is
 *   run through the alias map one hop (`aliasMap[tag] ?? tag`) — the same
 *   single-hop rule `applyOpponentAliases` uses — so a merged alias still
 *   lands on its canonical profile.
 */
export function resolveAnalyzeOpponentPreselection(
  params: URLSearchParams,
  matches: Match[],
  aliasMap: OpponentAliasMap,
): string | null {
  const player = params.get(ANALYZE_OPPONENT_PLAYER_PARAM);
  if (player) {
    const byId = matches.find((match) => {
      if (player.startsWith(STARTGG_PREFIX)) {
        return match.opponentUserSlug === player.slice(STARTGG_PREFIX.length);
      }
      if (player.startsWith(PARRYGG_PREFIX)) {
        return match.opponentParryUserId === player.slice(PARRYGG_PREFIX.length);
      }
      return false;
    });
    if (byId?.opponent) {
      return byId.opponent;
    }
  }

  const tag = params.get(ANALYZE_OPPONENT_TAG_PARAM);
  if (tag) {
    return Object.prototype.hasOwnProperty.call(aliasMap, tag) ? aliasMap[tag]! : tag;
  }
  return null;
}
