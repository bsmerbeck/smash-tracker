import type { Match } from '@smash-tracker/shared';
import { parseExternalId } from '@smash-tracker/shared';

/**
 * Honest finding this file is planned against: the VOD Manager has NO
 * set-view state. Library view is `applyVodManagerFilters` + `sortByRecency`
 * over `vodMatches`; Playlist view is explicit stored order with the
 * filter/sort controls hidden (`isPlaylistView`). There is no durable
 * "this list is one set" concept anywhere in the schema or the UI.
 *
 * Manual set-wizard games in particular carry no durable set identity:
 * `createMatchInputSchema` accepts no `externalId`/`source` on create —
 * those fields are server-set on synced (start.gg/parry.gg) records only.
 * So "the list is showing one set" can only be DERIVED, heuristically, from
 * the currently displayed library list — never read off a stored field.
 *
 * That derivation drives a DEFAULT SORT ONLY. `getDisplayedSetKey` never
 * filters, never reorders data, and never touches persistence — it is read
 * by the caller purely to pick 'oldest' vs 'newest' as the STARTING sort
 * direction. A false positive (a list that isn't really "one set" gets
 * treated as one) costs at most a differently-ordered default the user can
 * flip back in one click via the sort control — it can never hide a match,
 * corrupt a save, or desync from what's actually stored.
 *
 * A durable manual set id on the match record (written by the set wizard at
 * create time) is the proper long-term fix for this ambiguity — it is
 * deliberately out of scope here; this heuristic is a client-side stopgap.
 */

/**
 * The wizard persists every game of one set through a single sequential
 * submit loop (`AddMatchForm.handleSetSubmit`) — sub-second per game,
 * comfortably under a minute end-to-end even for a full Bo5. A generous
 * one-minute window catches any real set without also catching two
 * unrelated matches against the same opponent played minutes apart.
 */
export const MANUAL_SET_WINDOW_MS = 60_000;

/** No Bo5 (the longest set format the app supports) has more than 5 games. */
export const MAX_SET_GAMES = 5;

/**
 * Derives a stable grouping key for `matches` when — and only when — they
 * look like the games of exactly one set, or `null` otherwise.
 *
 * - Fewer than 2 matches: `null` (nothing to group).
 * - SYNCED branch: every match's `externalId` parses via `parseExternalId`
 *   AND every parse yields the same `setId` → a `sync:`-prefixed key.
 * - MANUAL branch: no match's `externalId` parses, the list has at most
 *   `MAX_SET_GAMES` matches, they all share the same `opponent`/`eventName`/
 *   `tournamentName` (absent treated as `''` so untagged quickplay sets
 *   still group), and `max(time) - min(time) <= MANUAL_SET_WINDOW_MS` → a
 *   `manual:`-prefixed key built from those three shared fields.
 * - Anything else (including a MIX of parseable and unparseable
 *   `externalId`s) → `null`.
 *
 * `fighter_id`/`opponent_id` are deliberately NOT part of either key:
 * per-game characters legitimately differ across the games of one set (see
 * `setWizardLogic.resolveSetFighterSelections`) — keying on them would
 * break exactly the case this feature targets.
 */
export function getDisplayedSetKey(matches: Match[]): string | null {
  if (matches.length < 2) {
    return null;
  }

  const parsed = matches.map((m) => parseExternalId(m.externalId));
  const allParsed = parsed.every((p): p is NonNullable<typeof p> => p != null);
  if (allParsed) {
    const setIds = new Set(parsed.map((p) => p!.setId));
    if (setIds.size === 1) {
      return `sync:${parsed[0]!.setId}`;
    }
    return null;
  }

  const noneParsed = parsed.every((p) => p == null);
  if (!noneParsed) {
    // A mix of parseable and unparseable externalIds — never group.
    return null;
  }

  if (matches.length > MAX_SET_GAMES) {
    return null;
  }

  const opponent = matches[0]!.opponent ?? '';
  const eventName = matches[0]!.eventName ?? '';
  const tournamentName = matches[0]!.tournamentName ?? '';
  const sameFields = matches.every(
    (m) =>
      (m.opponent ?? '') === opponent &&
      (m.eventName ?? '') === eventName &&
      (m.tournamentName ?? '') === tournamentName,
  );
  if (!sameFields) {
    return null;
  }

  const times = matches.map((m) => m.time);
  const spread = Math.max(...times) - Math.min(...times);
  if (spread > MANUAL_SET_WINDOW_MS) {
    return null;
  }

  return `manual:${opponent}:${eventName}:${tournamentName}`;
}
