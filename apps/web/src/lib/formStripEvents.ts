import type { TFunction } from 'i18next';
import type { Match } from '@smash-tracker/shared';
import { parseExternalId, splitIntoSessions, trimmedEventKey } from '@smash-tracker/shared';
import type { FormStripEvent, FormStripSet } from '@/components/charts/FormStrip';

/**
 * WR-04 (39.1-REVIEW.md): the ONE host-side builder of `FormStrip` events
 * for a flat match list — shared by Matchups (`MatchupChart.tsx`) and the
 * Fighter Analysis hero (`FighterHero.tsx`), which used to carry a second
 * derivation that still bucketed every manual game into one `__manual__`
 * group captioned "Unknown". (The opponent hub builds its strip from
 * `groupEncounters`' own event/session groups instead.)
 */

/**
 * The form-strip's set key: a real parsed `externalId` set id when one
 * exists, else a synthetic `game:<matchId>` key for a single manually-
 * entered game. Each host's `FilteredMatchList` `eventKeyForMatch`
 * resolver uses this EXACT rule, so a set click's `eventKey` axis always
 * narrows to precisely the games the strip drew that set from.
 */
export function formStripSetKeyForMatch(match: Match): string {
  const parsed = parseExternalId(match.externalId);
  return parsed ? parsed.setId : `game:${match.id}`;
}

/**
 * UI-SPEC §7.10: event -> set -> game, oldest first, grouped only (never
 * binned/windowed — `FormStrip` itself trims to `limit`). A match with no
 * parseable `externalId` becomes its own single-game set (see
 * `formStripSetKeyForMatch`) — unaffected by the session grouping below, which only
 * changes how the manual REMAINDER is bucketed at the event level, never
 * the per-set key `formStripSetKeyForMatch` resolves. `recentWindow` marks
 * each set `inRecentWindow` from the SAME `Insight.window` `formNow` already
 * resolved — one source of truth for "recent," never re-derived.
 *
 * Plan 39.1-31 (item 7, UI-SPEC §7.10/§8.6): a manual game (no event or
 * tournament name) used to fall into one flat `__manual__` bucket labelled
 * `common.unknown` ("Unknown") — untrue (there is no "unknown" here, only
 * "no named event") and, on an account with a long manual-only history, one
 * gigantic unbroken tick row. The manual remainder is now split by the
 * shared `splitIntoSessions` (the SAME 3-hour-gap session model
 * `OpponentHubPage.tsx`'s `buildOpponentFormStripEvents` and
 * `encounterGrouping.ts`'s `groupEncounters` already use for their own
 * manual remainders), one `FormStripEvent` per session, labelled
 * `analytics.strip.sessionLabel` with that session's first game's date.
 * Every event (named or session) is ordered by its own first game's time.
 * WR-01 (39.1-REVIEW.md): that group order alone is NOT chronological — a
 * recurring event name (start.gg's "Ultimate Singles" at every tournament)
 * spans years — so each set also carries `lastGameMs` and `FormStrip`
 * reorders sets by it across groups before trimming and fitting.
 */
export function buildFormStripEvents(
  matches: Match[],
  recentWindow: { fromMs: number | null; toMs: number | null },
  t: TFunction,
  locale: string,
): FormStripEvent[] {
  const sorted = [...matches].sort((a, b) => a.time - b.time);
  const byEvent = new Map<string, Match[]>();
  const manual: Match[] = [];
  for (const match of sorted) {
    const eventKey = trimmedEventKey(match);
    if (eventKey !== null) {
      const group = byEvent.get(eventKey);
      if (group) {
        group.push(match);
      } else {
        byEvent.set(eventKey, [match]);
      }
    } else {
      manual.push(match);
    }
  }

  const inWindow = (m: Match): boolean =>
    recentWindow.fromMs != null &&
    recentWindow.toMs != null &&
    m.time >= recentWindow.fromMs &&
    m.time <= recentWindow.toMs;

  function toFormStripEvent(key: string, label: string, eventMatches: Match[]): FormStripEvent {
    const bySet = new Map<string, Match[]>();
    for (const match of eventMatches) {
      const setKey = formStripSetKeyForMatch(match);
      const group = bySet.get(setKey);
      if (group) {
        group.push(match);
      } else {
        bySet.set(setKey, [match]);
      }
    }
    const sets: FormStripSet[] = [...bySet.entries()].map(([setKey, setMatches]) => {
      const wins = setMatches.filter((m) => m.win).length;
      const losses = setMatches.length - wins;
      const opponentTag = setMatches.find((m) => m.opponent)?.opponent ?? t('common.unknown');
      return {
        key: setKey,
        label: t('analytics.strip.setAria', {
          opponent: opponentTag,
          record: `${wins}–${losses}`,
        }),
        inRecentWindow: setMatches.some(inWindow),
        // WR-01: the kit orders sets by this across events before its trim/fit.
        lastGameMs: Math.max(...setMatches.map((m) => m.time)),
        // WR-02: the host's local date in the UI locale — the results list's own rule.
        games: setMatches.map((match) => ({
          key: match.id,
          won: match.win,
          label: `${match.win ? t('common.win') : t('common.loss')} · ${new Date(match.time).toLocaleDateString(locale)}`,
        })),
      };
    });
    // WR-03: no group record here — FormStrip computes it from the drawn games.
    return { key, label, sets };
  }

  const groups: { firstMs: number; event: FormStripEvent }[] = [];
  for (const [key, eventMatches] of byEvent) {
    groups.push({
      firstMs: eventMatches[0]!.time,
      event: toFormStripEvent(key, key, eventMatches),
    });
  }
  for (const session of splitIntoSessions(manual)) {
    const first = session[0]!;
    const date = new Intl.DateTimeFormat(locale, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    }).format(new Date(first.time));
    const label = t('analytics.strip.sessionLabel', { date });
    groups.push({
      firstMs: first.time,
      event: toFormStripEvent(`session:${first.id}`, label, session),
    });
  }

  groups.sort((a, b) => a.firstMs - b.firstMs);
  return groups.map((g) => g.event);
}
