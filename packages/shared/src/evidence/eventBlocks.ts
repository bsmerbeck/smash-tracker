import type { Match } from '../match.js';

/**
 * The ONE event-identity rule (39.2-REVIEW SH-CR-01 / WEB-CR-01), in a leaf module with no
 * runtime imports so the insight templates, the digest and the web's Dashboard can all read it
 * without pulling the rest of the evidence engine. `eventSeries.ts` re-exports the three names it
 * has always owned (`EVENT_ANCHOR_PROXIMITY_MS`, `trimmedEventKey`, `splitTournamentBlocks`), so
 * every existing import keeps working and the proximity rule still lives in exactly one place.
 *
 * An event is NEVER a bare event name: start.gg names nearly every bracket "Ultimate Singles", so
 * a name alone pools years of unrelated weeklies. An event is a name group — the event name plus
 * the parent tournament's name — split into proximity blocks by `splitTournamentBlocks`.
 */

/**
 * Ported from `apps/web/src/pages/Opponents/tournamentHistory.ts`'s
 * `TOURNAMENT_PROXIMITY_WINDOW_MS` — kept in sync by naming that file, not by
 * importing it (web must never be imported from `packages/shared`).
 *
 * WR-04 (38-REVIEW-FIX): exported so a caller that needs to construct a test
 * fixture spanning more than one proximity block (or otherwise reason about
 * the window) reads the real value rather than hard-coding `4` days.
 */
export const EVENT_ANCHOR_PROXIMITY_MS = 4 * 24 * 60 * 60 * 1000;

/**
 * CR-02 (38-REVIEW-FIX): the ONE name-priority rule for a tournament anchor
 * — `eventName` first, `tournamentName` as fallback. Exported so every other
 * module that needs to reproduce (never re-derive by hand) which name a
 * match's tournament anchor uses reads it from here — `apps/web`'s
 * `tournamentHistory.ts` (`tournamentBlockEventKey`) and `TournamentDetailPage.tsx`
 * both used to hard-code their OWN, differently-prioritized expression,
 * which silently diverged from the anchors `eventSeries.ts` actually builds
 * (`buildOpponentEventSeries`/`buildStageEventSeries`) whenever a match
 * carried both fields with different values — the standard shape for any
 * start.gg-synced set with a named parent tournament.
 */
export function trimmedEventKey(match: Match): string | null {
  const raw = match.eventName ?? match.tournamentName;
  if (raw == null) {
    return null;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * 41-13 (UAT 41 test 7, F6): the ONE event DISPLAY-label rule, beside the identity rule above.
 * DISPLAY ONLY — never a key, never a grouping input, never a URL axis (those stay
 * `trimmedEventKey`). Names the parent tournament when, and only when, EVERY game carries the
 * same non-empty tournament name: "Genesis 9 · Ultimate Singles". A tournament name equal to the
 * event name (case-insensitive) prints once; a mixed or partly-missing tournament falls back to
 * the bare event name (never a guessed tournament); no name at all is `null`.
 */
export function eventDisplayName(games: readonly Match[]): string | null {
  let event: string | null = null;
  for (const game of games) {
    event = trimmedEventKey(game);
    if (event !== null) break;
  }
  let tournament: string | null = null;
  for (const game of games) {
    const name = game.tournamentName?.trim() ?? '';
    if (name.length === 0 || (tournament !== null && name !== tournament)) {
      tournament = null;
      break;
    }
    tournament = name;
  }
  if (tournament !== null) {
    if (event === null || event.toLowerCase() === tournament.toLowerCase()) return tournament;
    return `${tournament} \u00b7 ${event}`;
  }
  return event;
}

/**
 * Splits one name-grouped, time-sorted set of tournament matches into blocks
 * whenever consecutive games exceed the proximity window — the same
 * technique `groupTournamentBlocks` uses, ported rather than imported.
 *
 * WR-04 (38-REVIEW-FIX): exported as the ONE place this block-splitting rule
 * lives — `TournamentDetailPage.tsx`'s per-stage anchor-key lookup calls this
 * directly (over its own stage-scoped, already name-uniform match list)
 * instead of re-implementing the proximity comparison, so it can never
 * silently diverge from what `buildStageEventSeries` itself will split a
 * stage's matches into.
 */
export function splitTournamentBlocks(sorted: Match[]): Match[][] {
  const blocks: Match[][] = [];
  let current: Match[] = [];
  for (const match of sorted) {
    const previous = current[current.length - 1];
    if (previous && match.time - previous.time > EVENT_ANCHOR_PROXIMITY_MS) {
      blocks.push(current);
      current = [match];
    } else {
      current.push(match);
    }
  }
  if (current.length > 0) {
    blocks.push(current);
  }
  return blocks;
}

/** One event: a name group's proximity block. */
export interface EventBlock {
  /** The event's display name (`trimmedEventKey` of its games). */
  eventKey: string;
  /**
   * The event's identity: its event name, its tournament name and its first game's timestamp.
   * Two same-named brackets never share it, so it is safe as a dismissal or "seen" key.
   */
  key: string;
  /** The block's games, oldest first. */
  games: Match[];
  startMs: number;
  endMs: number;
}

function trimmedTournamentName(match: Match): string {
  return match.tournamentName?.trim() ?? '';
}

/**
 * Every event in `matches`: games grouped by (event name, tournament name), each group split
 * into proximity blocks. Games naming no event belong to no block. Ordered by start, then key,
 * so the result never depends on input order. Does not mutate its input.
 */
export function eventBlocksOf(matches: readonly Match[]): EventBlock[] {
  const groups = new Map<string, { eventKey: string; tournament: string; games: Match[] }>();
  for (const match of matches) {
    const eventKey = trimmedEventKey(match);
    if (eventKey === null) continue;
    const tournament = trimmedTournamentName(match);
    // JSON of the pair: no separator character inside a name can make two pairs collide.
    const groupKey = JSON.stringify([eventKey, tournament]);
    const group = groups.get(groupKey);
    if (group) {
      group.games.push(match);
    } else {
      groups.set(groupKey, { eventKey, tournament, games: [match] });
    }
  }
  const blocks: EventBlock[] = [];
  for (const { eventKey, tournament, games } of groups.values()) {
    const sorted = [...games].sort((a, b) => a.time - b.time);
    for (const block of splitTournamentBlocks(sorted)) {
      const startMs = block[0]!.time;
      blocks.push({
        eventKey,
        key: `event:${JSON.stringify([eventKey, tournament])}@${startMs}`,
        games: block,
        startMs,
        endMs: block[block.length - 1]!.time,
      });
    }
  }
  return blocks.sort((a, b) =>
    a.startMs !== b.startMs ? a.startMs - b.startMs : a.key < b.key ? -1 : a.key > b.key ? 1 : 0,
  );
}

/**
 * The event holding the newest event-named game (the first such game in input order on a tie,
 * the rule the recap has always used), with that game; `null` when no game names an event.
 */
export function newestEventBlock(
  matches: readonly Match[],
): { block: EventBlock; newestGame: Match } | null {
  let newest: Match | null = null;
  for (const match of matches) {
    if (trimmedEventKey(match) === null) continue;
    if (newest === null || match.time > newest.time) {
      newest = match;
    }
  }
  if (newest === null) return null;
  const newestGame = newest;
  const block = eventBlocksOf(matches).find((candidate) => candidate.games.includes(newestGame));
  return block ? { block, newestGame } : null;
}
