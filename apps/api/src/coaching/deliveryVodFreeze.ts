import type { Database } from 'firebase-admin/database';
import {
  getFighterById,
  includedVodSchema,
  matchRecordSchema,
  MAX_DELIVERY_VODS,
  type IncludedVod,
  type MatchRecord,
} from '@smash-tracker/shared';
import { isPathSafeMatchId } from '../services/rtdb.js';

/**
 * Phase 21 (Rich Client Delivery View, DLVX-02/DLVX-04): builds the FROZEN
 * `includedVods` array both `createReviewDelivery` and `createSessionDelivery`
 * embed in a delivery record at creation time (D-10 / Pitfall 3 immutability
 * — never called from the anonymous GET read path, only from delivery
 * CREATION). Shared by both delivery services so the freeze discipline is
 * defined exactly once, never hand-rolled twice divergently.
 *
 * For each `pickedMatchIds` entry, in order:
 * - a malformed/path-unsafe matchId is skipped BEFORE any `ref()` call
 *   (review WR-07 discipline, reusing `rtdb.ts`'s own `isPathSafeMatchId`)
 * - resolved against `matches/{tenantId}/{matchId}` where `tenantId` is the
 *   delivery's OWN tenant (never caller-supplied) — T-21-03: a matchId that
 *   doesn't exist under this tenant (foreign/cross-tenant, or simply never
 *   existed) is silently dropped, never thrown/leaked
 * - a match with no `vodUrl` is silently dropped (nothing to freeze)
 * - otherwise authored as a NEW `IncludedVod` object literal FROM SCRATCH —
 *   `matchId`, `vodUrl`, `startSeconds` (from `vodStartSeconds`), `timestamps`
 *   (from `vodTimestamps`, capped 20, mapped to the `{ seconds, note, tags? }`
 *   share shape), and a structurally-safe `label` (a public-game-data fighter
 *   matchup, e.g. "Kazuya vs Sora" — NEVER the opponent's human name,
 *   opponent notes, or any other private match field, T-21-01). The raw
 *   match record is never spread.
 *
 * The input list is capped to `MAX_DELIVERY_VODS` BEFORE resolving (defense
 * in depth alongside the route body schema's own `.max()` — T-21-04), so
 * this function never issues more than `MAX_DELIVERY_VODS` RTDB reads
 * regardless of what a caller passes.
 */
export async function freezeIncludedVods(
  database: Database,
  tenantId: string,
  pickedMatchIds: string[],
): Promise<IncludedVod[]> {
  const capped = pickedMatchIds.slice(0, MAX_DELIVERY_VODS);

  const resolved = await Promise.all(
    capped.map(async (matchId): Promise<IncludedVod | null> => {
      if (!isPathSafeMatchId(matchId)) {
        return null;
      }
      const matchSnapshot = await database.ref(`matches/${tenantId}/${matchId}`).get();
      if (!matchSnapshot.exists()) {
        return null;
      }
      const parsedMatch = matchRecordSchema.safeParse(matchSnapshot.val());
      if (!parsedMatch.success) {
        return null;
      }
      const match = parsedMatch.data;
      if (!match.vodUrl) {
        return null;
      }
      const vodUrl = match.vodUrl;
      const label = buildVodMatchupLabel(match);

      const frozen: IncludedVod = {
        matchId,
        vodUrl,
        ...(label ? { label } : {}),
        ...(match.vodStartSeconds != null ? { startSeconds: match.vodStartSeconds } : {}),
        ...(match.vodTimestamps && match.vodTimestamps.length > 0
          ? {
              timestamps: match.vodTimestamps.slice(0, 20).map((entry) => ({
                seconds: entry.seconds,
                note: entry.note,
                ...(entry.tags && entry.tags.length > 0 ? { tags: entry.tags } : {}),
              })),
            }
          : {}),
      };

      return includedVodSchema.parse(frozen);
    }),
  );

  return resolved
    .filter((entry): entry is IncludedVod => entry !== null)
    .slice(0, MAX_DELIVERY_VODS);
}

/**
 * A structurally-safe descriptor for a frozen VOD (T-21-01): the two
 * SpriteList fighter names involved, both of which are public game data
 * (never the private human opponent name/notes). Returns `undefined` when
 * either fighter id is unrecognized (defensive — every real match record
 * carries valid SpriteList ids, but a `label` here must never throw).
 */
function buildVodMatchupLabel(match: MatchRecord): string | undefined {
  const own = getFighterById(match.fighter_id)?.name;
  const opponent = getFighterById(match.opponent_id)?.name;
  return own && opponent ? `${own} vs ${opponent}` : undefined;
}
