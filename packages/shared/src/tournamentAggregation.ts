import type { Match } from './match.js';
import type { TournamentEntry } from './startgg.js';

const WINDOW_PAD_MS = 24 * 60 * 60 * 1000;

/**
 * Matches carry no `eventId` (start.gg sync enriches them with name fields
 * only — see docs on `MatchRecord`), so a match is attributed to a
 * `TournamentEntry` by:
 *
 *  1. `match.eventName === entry.eventName` (required — entries always have
 *     an event name).
 *  2. `entry.tournamentName == null || match.tournamentName === entry.tournamentName`
 *     — when the entry has no tournament name, any (or no) match
 *     tournamentName is accepted; when it does, the match must match
 *     exactly. This disambiguates same-named events run at different
 *     tournaments (e.g. two different weeklies both hosting "Ultimate
 *     Singles").
 *  3. `match.time` falls within `[entry.firstSetAt - 24h, entry.lastSetAt + 24h]`
 *     — a padded window around the entry's known set range, to tolerate
 *     clock skew / grouping edge cases without accidentally spanning into an
 *     unrelated same-named event weeks apart.
 *
 * Pure and side-effect free so it's usable both for building the per-entry
 * timeline and for computing per-entry records in the Trends tournaments
 * table.
 */
export function matchesForEntry(matches: Match[], entry: TournamentEntry): Match[] {
  const windowStart = entry.firstSetAt - WINDOW_PAD_MS;
  const windowEnd = entry.lastSetAt + WINDOW_PAD_MS;

  return matches.filter((match) => {
    if (match.eventName !== entry.eventName) {
      return false;
    }
    if (entry.tournamentName != null && match.tournamentName !== entry.tournamentName) {
      return false;
    }
    return match.time >= windowStart && match.time <= windowEnd;
  });
}

/**
 * Parses either of the two externalId conventions this codebase writes:
 *  - start.gg: `sgg:{setId}:g{n}` (see apps/api/src/startgg/sync.ts `gamesFromSet`)
 *  - parry.gg: `pgg-{matchId}-g{n}` (see apps/api/src/parrygg/sync.ts
 *    `gamesFromMatchContext`) — dash-separated; the matchId is used as the
 *    setId so all games of one parry.gg match group into one set.
 * Returns `null` for manually-entered matches (no `externalId`) or any
 * externalId that doesn't match either expected shape.
 */
export function parseExternalId(
  externalId: string | undefined,
): { setId: string; game: number } | null {
  if (!externalId) {
    return null;
  }
  const sggMatch = /^sgg:(.+):g(\d+)$/.exec(externalId);
  const pggMatch = sggMatch ? null : /^pgg-(.+)-g(\d+)$/.exec(externalId);
  const match = sggMatch ?? pggMatch;
  if (!match) {
    return null;
  }
  const [, setId, gameStr] = match;
  const game = Number(gameStr);
  if (!setId || !Number.isFinite(game)) {
    return null;
  }
  return { setId, game };
}

export interface SetGame {
  match: Match;
  gameNumber: number;
}

export interface TournamentSet {
  setId: string;
  /** Chronologically first game's time — used to order sets. */
  time: number;
  /** start.gg's human round label, when available. */
  roundText: string | undefined;
  /** start.gg's signed round integer; negative = losers side. */
  bracketRound: number | undefined;
  /** The tracked user's fighter id(s) played across this set's games, in first-seen order. */
  userFighterIds: number[];
  /** The opponent's fighter id(s) faced across this set's games, in first-seen order. */
  opponentFighterIds: number[];
  /** The human opponent's free-text tag for this set, when any game carries one. */
  opponentName: string | undefined;
  /** The human opponent's seed in this event, when start.gg provided it (Phase B sync). */
  opponentSeed: number | undefined;
  /** The human opponent's final placement in this event, when start.gg provided it (Phase B sync). */
  opponentPlacement: number | undefined;
  /** The human opponent's start.gg profile slug, when start.gg provided it (Phase B sync). */
  opponentUserSlug: string | undefined;
  /** The human opponent's parry.gg user id (a UUID), when parry.gg provided it (07-11 walkthrough round 3). */
  opponentParryUserId: string | undefined;
  /** Games in the set, ordered by game number. */
  games: SetGame[];
  /** Games won by the tracked user within this set. */
  gamesWon: number;
  /** Games lost by the tracked user within this set. */
  gamesLost: number;
  /** Whether the tracked user won the set overall (more games won than lost). */
  won: boolean;
}

/**
 * Groups an entry's matches into sets (parsed from `externalId`), ordered
 * chronologically, plus a separate list of matches that don't belong to any
 * parseable set (manual entries, or imports predating the externalId
 * convention). `roundText`/`bracketRound`/`opponentName`/`opponentSeed`/
 * `opponentPlacement`/`opponentUserSlug`/`opponentParryUserId` are read off
 * the first game that carries them (imports before the relevant resync lack
 * these fields entirely — every consumer must tolerate `undefined`).
 */
export interface SetTimeline {
  sets: TournamentSet[];
  /** Matches during the event that couldn't be grouped into a set (no parseable externalId). */
  otherMatches: Match[];
}

export function buildSetTimeline(entryMatches: Match[]): SetTimeline {
  const bySet = new Map<string, SetGame[]>();
  const otherMatches: Match[] = [];

  for (const match of entryMatches) {
    const parsed = parseExternalId(match.externalId);
    if (!parsed) {
      otherMatches.push(match);
      continue;
    }
    const group = bySet.get(parsed.setId);
    const game: SetGame = { match, gameNumber: parsed.game };
    if (group) {
      group.push(game);
    } else {
      bySet.set(parsed.setId, [game]);
    }
  }

  const sets: TournamentSet[] = [...bySet.entries()].map(([setId, games]) => {
    const ordered = [...games].sort((a, b) => a.gameNumber - b.gameNumber);
    const gamesWon = ordered.filter((g) => g.match.win).length;
    const gamesLost = ordered.length - gamesWon;

    const userFighterIds: number[] = [];
    const opponentFighterIds: number[] = [];
    for (const g of ordered) {
      if (!userFighterIds.includes(g.match.fighter_id)) {
        userFighterIds.push(g.match.fighter_id);
      }
      if (!opponentFighterIds.includes(g.match.opponent_id)) {
        opponentFighterIds.push(g.match.opponent_id);
      }
    }

    return {
      setId,
      time: Math.min(...ordered.map((g) => g.match.time)),
      roundText: ordered.map((g) => g.match.roundText).find((r) => r != null),
      bracketRound: ordered.map((g) => g.match.bracketRound).find((r) => r != null),
      userFighterIds,
      opponentFighterIds,
      opponentName: ordered.map((g) => g.match.opponent).find((r) => r != null),
      opponentSeed: ordered.map((g) => g.match.opponentSeed).find((r) => r != null),
      opponentPlacement: ordered.map((g) => g.match.opponentPlacement).find((r) => r != null),
      opponentUserSlug: ordered.map((g) => g.match.opponentUserSlug).find((r) => r != null),
      opponentParryUserId: ordered.map((g) => g.match.opponentParryUserId).find((r) => r != null),
      games: ordered,
      gamesWon,
      gamesLost,
      won: gamesWon > gamesLost,
    };
  });

  sets.sort((a, b) => a.time - b.time);

  otherMatches.sort((a, b) => a.time - b.time);

  return { sets, otherMatches };
}

/**
 * English ordinal suffix for a positive integer (1st, 2nd, 3rd, 4th, ...11th,
 * 12th, 13th, 21st...). The 11-13 teens are a special case that always take
 * "th" regardless of their last digit. Exported standalone (rather than
 * baked into a single formatter) so callers can compose it with their own
 * label text.
 */
export function ordinalSuffix(n: number): string {
  const abs = Math.abs(n);
  const lastTwo = abs % 100;
  if (lastTwo >= 11 && lastTwo <= 13) {
    return 'th';
  }
  switch (abs % 10) {
    case 1:
      return 'st';
    case 2:
      return 'nd';
    case 3:
      return 'rd';
    default:
      return 'th';
  }
}

/** Formats a positive integer with its ordinal suffix, e.g. `129` -> "129th". */
export function formatOrdinal(n: number): string {
  return `${n}${ordinalSuffix(n)}`;
}

/**
 * Compact "seed 56 · placed 129th" label for an opponent's per-event
 * context, when at least one of seed/placement is known. Returns `null`
 * when both are absent so callers can omit the fragment cleanly.
 */
export function formatOpponentEventContext(opponent: {
  seed?: number;
  placement?: number;
}): string | null {
  const parts: string[] = [];
  if (opponent.seed != null) {
    parts.push(`seed ${opponent.seed}`);
  }
  if (opponent.placement != null) {
    parts.push(`placed ${formatOrdinal(opponent.placement)}`);
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}

const STARTGG_BASE_URL = 'https://start.gg';
const PARRYGG_BASE_URL = 'https://parry.gg';

/** start.gg profile slug shape, e.g. "user/07dc2239" — exactly what `TournamentSet.opponentUserSlug`/`apps/web`'s `buildStartggUrl` expect on the owner timeline. */
const STARTGG_USER_SLUG_SHAPE = /^user\/[A-Za-z0-9]+$/;

/** parry.gg user id shape — a UUID (any RFC 4122 version/variant octet). */
const PARRY_UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A start.gg set id — always a digit string once parsed off `sgg:{setId}:g{n}` (see `parseExternalId`/`TournamentSet.setId`). */
const NUMERIC_ID_SHAPE = /^[0-9]+$/;

/**
 * Walkthrough round 3 (07-11): URL-path-safe slug/segment charset validator
 * — letters, digits, `/`, `_`, `-` only, no leading/trailing slash, no
 * doubled slash. Covers both start.gg's multi-segment slugs
 * ("tournament/x/event/y") and parry.gg's bare kebab-case slugs
 * ("third-street-throwdown-summer-e3-019f5918"). Every URL this module
 * builds interpolates a stored (never client-supplied) slug/id through this
 * check first — a malformed value (never expected from either site's own
 * data, but defense-in-depth against a corrupted/legacy record) means the
 * URL is omitted entirely, never rendered malformed.
 */
function isSafeSlugSegment(value: string): boolean {
  return /^[A-Za-z0-9](?:[A-Za-z0-9/_-]*[A-Za-z0-9])?$/.test(value) && !value.includes('//');
}

/**
 * Phase 7 walkthrough amendment (07-09; parry.gg support added in the
 * walkthrough round 3, 07-11): a trustworthy external tournament link for a
 * recap card — built ONLY from fields the registry actually stores, never
 * guessed. start.gg entries (`source` absent or `'startgg'`) deep-link from
 * `eventSlug` (preferred — the specific bracket the entry belongs to) or
 * fall back to the tournament-level `slug`, exactly mirroring `apps/web`'s
 * `buildEventStartggUrl`/`buildStartggUrl` (kept as a separate, duplicate
 * implementation here since `apps/api` cannot import from `apps/web`, and
 * this is the only site the shared package needs to know about).
 *
 * parry.gg entries deep-link from the tournament-level `slug` (07-11:
 * `apps/api/src/parrygg/sync.ts`'s `accumulateParryggRegistry` now persists
 * this from the match context's own hierarchy path — previously unstored),
 * preferring the deeper `/{slug}/{eventSlug}/main/bracket` bracket URL when
 * BOTH the tournament and event slugs are on record, falling back to the
 * bare `/{slug}` tournament page when only the tournament slug is known.
 * `null` when the tournament-level slug itself hasn't synced yet (every
 * pre-07-11 parry.gg entry) — this is absence of data, not a design
 * decision against parry.gg links (unlike the pre-07-11 "never invent a
 * parry.gg URL" stance, now superseded by the verified shapes in
 * 07-CONTEXT.md's walkthrough round 3).
 */
export function buildRecapTournamentUrl(
  entry: Pick<TournamentEntry, 'source' | 'slug' | 'eventSlug'>,
): string | null {
  if (entry.source === 'parrygg') {
    const slug = entry.slug;
    if (!slug || !isSafeSlugSegment(slug)) {
      return null;
    }
    const eventSlug = entry.eventSlug;
    if (eventSlug && isSafeSlugSegment(eventSlug)) {
      return `${PARRYGG_BASE_URL}/${slug}/${eventSlug}/main/bracket`;
    }
    return `${PARRYGG_BASE_URL}/${slug}`;
  }
  const slug = entry.eventSlug ?? entry.slug;
  return slug ? `${STARTGG_BASE_URL}/${slug}` : null;
}

/**
 * Walkthrough round 3 (07-11): a trustworthy external profile link for one
 * set's human opponent. start.gg entries use the set's own
 * `opponentUserSlug` (Phase B sync), validated against the exact
 * `user/{id}` shape `apps/web`'s owner-timeline `OpponentLabel` already
 * relies on. parry.gg entries use the set's `opponentParryUserId` (07-11:
 * now persisted by `apps/api/src/parrygg/sync.ts`), validated as a UUID.
 * Returns `null` (never a malformed URL) when the relevant field is absent
 * or doesn't match its expected shape.
 */
export function buildRecapOpponentUrl(
  entry: Pick<TournamentEntry, 'source'>,
  set: Partial<Pick<TournamentSet, 'opponentUserSlug' | 'opponentParryUserId'>>,
): string | null {
  if (entry.source === 'parrygg') {
    const id = set.opponentParryUserId;
    return id && PARRY_UUID_SHAPE.test(id) ? `${PARRYGG_BASE_URL}/profile/${id}` : null;
  }
  const slug = set.opponentUserSlug;
  return slug && STARTGG_USER_SLUG_SHAPE.test(slug) ? `${STARTGG_BASE_URL}/${slug}` : null;
}

/**
 * Walkthrough round 3 (07-11): a trustworthy external SET page — start.gg
 * only (`https://start.gg/{eventSlug}/set/{setId}/summary`, the verified
 * shape confirmed in 07-CONTEXT.md's walkthrough round 3). Requires BOTH the
 * entry's `eventSlug` (never falls back to the coarser tournament-level
 * `slug` — a set page only resolves under its own event's path) AND the
 * set's own numeric `setId`. parry.gg sets are NEVER URL-addressable (no
 * verified public shape exists) — always `null` for a parry.gg entry, by
 * design, not merely absence of data.
 */
export function buildRecapSetUrl(
  entry: Pick<TournamentEntry, 'source' | 'eventSlug'>,
  set: Pick<TournamentSet, 'setId'>,
): string | null {
  if (entry.source === 'parrygg') {
    return null;
  }
  const eventSlug = entry.eventSlug;
  if (!eventSlug || !isSafeSlugSegment(eventSlug) || !NUMERIC_ID_SHAPE.test(set.setId)) {
    return null;
  }
  return `${STARTGG_BASE_URL}/${eventSlug}/set/${set.setId}/summary`;
}
