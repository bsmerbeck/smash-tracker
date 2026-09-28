import type { TFunction } from 'i18next';
import type { HorizonKey, Insight, Match } from '@smash-tracker/shared';
import { parseExternalId, splitIntoSessions } from '@smash-tracker/shared';
import type { FormStripEvent, FormStripLabels, FormStripSet } from '@/components/charts/FormStrip';

/**
 * WR-04 (39.1-REVIEW.md) / plan 39.1-42: the ONE host-side derivation of
 * `FormStrip` events AND of the set key every strip host's drill terminus
 * resolves — Matchups (`MatchupChart.tsx`), the Fighter Analysis hero
 * (`FighterHero.tsx`), the opponent hub and Trends' thin career timeline.
 */

/**
 * Plan 39.1-42 (PD-42-2): a strip group's display name — the trimmed
 * TOURNAMENT name first (start.gg writes the same bracket name, "Ultimate
 * Singles", at every tournament, so the bracket name alone would merge
 * unrelated events), then the trimmed event name, else null (a manual game
 * with no named event, which the session rule below groups).
 */
export function formStripEventLabel(match: Match): string | null {
  for (const raw of [match.tournamentName, match.eventName]) {
    const trimmed = raw?.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return null;
}

/**
 * Plan 39.1-42 (owner decision [HUMAN] 2026-09-25, sketch 002-C; PD-42-4):
 * every game's strip SET key. A start.gg / parry.gg game keeps its parsed
 * set id. A game with no parsed set id belongs to its PLAY SESSION —
 * `splitIntoSessions`' default 3-hour gap, the same rule behind the
 * "Session · date" labels — keyed `manual-session:<id of the session's first
 * game>`. Sessions are split within one display name (`formStripEventLabel`,
 * null for unnamed games), so a set never spans two strip groups. Pure and
 * independent of input order (sessions sort by time; ties break by id).
 */
export function buildFormStripSetKeys(matches: Match[]): Map<string, string> {
  const keys = new Map<string, string>();
  const keylessByLabel = new Map<string, Match[]>();
  for (const match of matches) {
    const parsed = parseExternalId(match.externalId);
    if (parsed) {
      keys.set(match.id, parsed.setId);
      continue;
    }
    const bucketKey = formStripEventLabel(match) ?? '';
    const bucket = keylessByLabel.get(bucketKey);
    if (bucket) {
      bucket.push(match);
    } else {
      keylessByLabel.set(bucketKey, [match]);
    }
  }
  for (const bucket of keylessByLabel.values()) {
    const ordered = [...bucket].sort((a, b) => a.time - b.time || compareIds(a.id, b.id));
    for (const session of splitIntoSessions(ordered)) {
      const key = `${MANUAL_SESSION_KEY_PREFIX}${session[0]!.id}`;
      for (const match of session) {
        keys.set(match.id, key);
      }
    }
  }
  return keys;
}

/**
 * Plan 39.1-42: the terminus resolver every strip host passes (through its
 * `FilteredMatchList` `eventKeyForMatch`), built over the SAME match base the
 * host's strip is built from. A manual game resolves to its session set key
 * AND its legacy per-game `game:<id>` key, so a link shared before this plan
 * still lands on its one game; a parsed game resolves to its set id.
 */
export function createFormStripSetKeyResolver(matches: Match[]): (match: Match) => string[] {
  const keys = buildFormStripSetKeys(matches);
  return (match) => {
    const parsed = parseExternalId(match.externalId);
    if (parsed) {
      return [parsed.setId];
    }
    const legacy = `${LEGACY_GAME_KEY_PREFIX}${match.id}`;
    const setKey = keys.get(match.id);
    return setKey ? [setKey, legacy] : [legacy];
  };
}

const MANUAL_SESSION_KEY_PREFIX = 'manual-session:';
const LEGACY_GAME_KEY_PREFIX = 'game:';

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The ONE label for a manual-session `FormStrip` group, shared by all three
 * strip hosts: `analytics.strip.sessionLabel` with the session's FIRST game's
 * date (host-local zone, UI locale). Date only, never a record: the kit
 * appends the record of the games it actually draws (39.1-REVIEW iteration 2
 * WR-02 — a session the `limit` trim or width fit cuts must never state a
 * record for games that are not on screen).
 */
export function formStripSessionLabel({
  firstGameMs,
  t,
  locale,
}: {
  firstGameMs: number;
  t: TFunction;
  locale: string;
}): string {
  const date = new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(new Date(firstGameMs));
  return t('analytics.strip.sessionLabel', { date });
}

/**
 * Plan 39.1-42 (PD-42-4, planner part): the label of a RUN of consecutive
 * manual sessions — `analytics.strip.sessionRun` with the run's date span
 * (first game to last game, host-local zone, UI locale; `formatRange`
 * collapses a shared month / year). Sketch 002-C draws this group
 * unlabelled; every shown strip event now carries a label (sketch 003).
 */
function formStripSessionRunLabel({
  firstGameMs,
  lastGameMs,
  t,
  locale,
}: {
  firstGameMs: number;
  lastGameMs: number;
  t: TFunction;
  locale: string;
}): string {
  const span = new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).formatRange(new Date(firstGameMs), new Date(lastGameMs));
  return t('analytics.strip.sessionRun', { span });
}

/**
 * UI-SPEC §7.10 (as amended by plan 39.1-42): event -> set -> game, oldest
 * first, grouped only (never binned / windowed — `FormStrip` itself trims to
 * `limit` and drops older EVENTS to fit).
 *
 * - Set keys come from `buildFormStripSetKeys` over the SAME `matches`, so
 *   the strip and every host's terminus agree: a start.gg / parry.gg set is
 *   its parsed set, a manual play session is ONE set (owner, 2026-09-25).
 * - A game with a display name (`formStripEventLabel`: tournament, then
 *   event) groups under that name (PD-42-2) — two tournaments that share a
 *   bracket name are two groups.
 * - Unnamed games are split into play sessions; each run of CONSECUTIVE
 *   sessions (no named group between them in time order) is ONE group whose
 *   sets are its sessions, labelled with the run's date span
 *   (`analytics.strip.sessionRun`); a one-session run keeps the
 *   `formStripSessionLabel` form.
 * - `recentWindow` marks each set `inRecentWindow` from the SAME
 *   `Insight.window` `formNow` already resolved — one source of truth for
 *   "recent". Each set carries `lastGameMs` (WR-01) so the kit orders sets
 *   across groups before its trim and fit.
 */
export function buildFormStripEvents(
  matches: Match[],
  recentWindow: { fromMs: number | null; toMs: number | null },
  t: TFunction,
  locale: string,
): FormStripEvent[] {
  const sorted = [...matches].sort((a, b) => a.time - b.time || compareIds(a.id, b.id));
  const setKeys = buildFormStripSetKeys(sorted);
  const byName = new Map<string, Match[]>();
  const unnamed: Match[] = [];
  for (const match of sorted) {
    const name = formStripEventLabel(match);
    if (name === null) {
      unnamed.push(match);
      continue;
    }
    const group = byName.get(name);
    if (group) {
      group.push(match);
    } else {
      byName.set(name, [match]);
    }
  }

  // Plan 39.1-42 (UI-SPEC §7.10 "collapsed: no dimming", sketch 002-C): with
  // no recent window (collapsed horizons, or no insight) nothing is dimmed;
  // a window with no games still dims every set (§7.10 zero-data rule).
  const hasWindow = recentWindow.fromMs != null && recentWindow.toMs != null;
  const inWindow = (m: Match): boolean =>
    !hasWindow || (m.time >= recentWindow.fromMs! && m.time <= recentWindow.toMs!);

  function toFormStripEvent(key: string, label: string, eventMatches: Match[]): FormStripEvent {
    const bySet = new Map<string, Match[]>();
    for (const match of eventMatches) {
      const setKey = setKeys.get(match.id)!;
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

  type Unit =
    | { kind: 'named'; firstMs: number; name: string; matches: Match[] }
    | { kind: 'session'; firstMs: number; matches: Match[] };
  const units: Unit[] = [];
  for (const [name, eventMatches] of byName) {
    units.push({ kind: 'named', firstMs: eventMatches[0]!.time, name, matches: eventMatches });
  }
  for (const session of splitIntoSessions(unnamed)) {
    units.push({ kind: 'session', firstMs: session[0]!.time, matches: session });
  }
  units.sort((a, b) => a.firstMs - b.firstMs || compareIds(a.matches[0]!.id, b.matches[0]!.id));

  const events: FormStripEvent[] = [];
  let run: Match[][] = [];
  const flushRun = () => {
    if (run.length === 0) {
      return;
    }
    const first = run[0]![0]!;
    const runMatches = run.flat();
    const last = runMatches[runMatches.length - 1]!;
    const label =
      run.length === 1
        ? formStripSessionLabel({ firstGameMs: first.time, t, locale })
        : formStripSessionRunLabel({ firstGameMs: first.time, lastGameMs: last.time, t, locale });
    events.push(
      toFormStripEvent(
        `${run.length === 1 ? 'session' : 'sessions'}:${first.id}`,
        label,
        runMatches,
      ),
    );
    run = [];
  };
  for (const unit of units) {
    if (unit.kind === 'session') {
      run.push(unit.matches);
      continue;
    }
    flushRun();
    events.push(toFormStripEvent(`event:${unit.name}`, unit.name, unit.matches));
  }
  flushRun();
  return events;
}

/**
 * Plan 39.1-42 (sketch 003 `stripLegend` / `fitStrips`): the labels every
 * FormStrip host passes — the head's four legend items and the foot's two
 * formatters (N of M shown with the drop rule, or all N). Hosts add their
 * own row `summary` (each call site stays visible to the strip-aria caller
 * oracle, `stripAriaCallers.test.ts`), `title`, `empty` node and window note.
 */
export function formStripLabels(
  t: TFunction,
): Pick<FormStripLabels, 'legend' | 'shownOfTotal' | 'allShown'> {
  return {
    legend: {
      win: t('analytics.strip.legendItem.win'),
      loss: t('analytics.strip.legendItem.loss'),
      setGap: t('analytics.strip.legendItem.setGap'),
      eventLabel: t('analytics.strip.legendItem.eventLabel'),
    },
    shownOfTotal: ({ shown, total }) => t('analytics.strip.footShownOf', { shown, total }),
    allShown: ({ total }) => t('analytics.strip.allShown', { count: total }),
  };
}

/**
 * Plan 39.1-42 (UI-SPEC §7.10 zero-data rule): a recent window that holds NO
 * game — every set falls outside it, so every tick dims. Distinct from "no
 * window" (`{ fromMs: null, toMs: null }`), which dims nothing.
 */
export const FORM_STRIP_EMPTY_WINDOW: { fromMs: number; toMs: number } = {
  fromMs: Number.POSITIVE_INFINITY,
  toMs: Number.NEGATIVE_INFINITY,
};

/**
 * Plan 39.1-42 (UI-SPEC §7.10): the strip's recent window from the host's
 * `formNow` insight — none (nothing dimmed) without an insight or when its
 * horizons collapse (the foot reads "Whole record shown"); the empty window
 * when the horizon holds no games (every tick dimmed); else its real span.
 */
export function formStripRecentWindow(insight: Insight | null | undefined): {
  fromMs: number | null;
  toMs: number | null;
} {
  if (!insight || insight.state === 'collapsed') {
    return { fromMs: null, toMs: null };
  }
  if (insight.window.games === 0 || insight.window.fromMs == null || insight.window.toMs == null) {
    return FORM_STRIP_EMPTY_WINDOW;
  }
  return { fromMs: insight.window.fromMs, toMs: insight.window.toMs };
}

/**
 * Plan 39.1-42 (sketch 003 `winNote`): the foot's window note from the
 * host's `formNow` insight — "No games in … — showing all time." when the
 * window is empty, "Whole record shown" when the horizons collapse (recent =
 * all time, nothing dimmed), else the highlighted window.
 */
export function formStripWindowNote({
  insight,
  horizon,
  t,
}: {
  insight: Insight | null | undefined;
  horizon: HorizonKey;
  t: TFunction;
}): string | undefined {
  if (!insight) {
    return undefined;
  }
  if (insight.window.games === 0) {
    return t(`analytics.strip.windowEmpty.${horizon}`);
  }
  if (insight.state === 'collapsed') {
    return t('analytics.strip.windowAll');
  }
  return t(`analytics.strip.windowHighlighted.${horizon}`);
}
