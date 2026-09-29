import type { TFunction } from 'i18next';
import {
  INSIGHT_TEMPLATES,
  resolveOpponentIdentities,
  toRateValue,
  trackedItemScope,
  type DigestMovedToken,
  type HorizonKey,
  type Match,
  type WatchlistItem,
  type WatchlistResponse,
} from '@smash-tracker/shared';
import { deltaChipView, type DeltaChipView } from '@/components/analytics/deltaChipView';
import type { MiniStripGame } from '@/components/charts/inlineMarks';
import { localizedFighterName } from '@/lib/fighterNames';
import { buildOpponentHubPath } from '@/lib/analyzeOpponent';
import { buildDrillDownSearch } from '@/lib/drillDownParams';
import { getStageById } from '@/data/stages';

/** DD-17: the Tracked row's mini strip draws the last 10 games in the item's scope. */
export const TRACKED_STRIP_GAMES = 10;

/**
 * The `formNow` template looked up by id: `formNowTemplate` is not a public
 * export of `@smash-tracker/shared` (only the closed registry is), the same
 * precedent `MatchupChart.tsx` and `OpponentHubPage.tsx` follow. Resolved once
 * at module scope; the registry is a static, closed array.
 */
const FORM_NOW_TEMPLATE = INSIGHT_TEMPLATES.find((template) => template.id === 'formNow')!;

/** One stored watchlist entry as the wire delivers it. */
export type WatchlistEntry = WatchlistResponse['items'][number];

/** Everything one Tracked row renders, derived once so the full row, the compact row and the tests share it. */
export interface TrackedRowModel {
  /** The stored key of the entry the row stands for (the untrack target). */
  itemKey: string;
  /** Every stored key that folds into this row: more than one when alias merges made two items one identity (E7). */
  itemKeys: string[];
  kind: WatchlistItem['kind'];
  /** The localised display name; an unresolved fighter or stage renders its stored ref as text. */
  name: string;
  /** The item's own surface as a PERSONAL path; the row applies `useSubjectPath` so it never leaves the subject's family. */
  href: string;
  /** The stage thumb source, for a stage that still resolves. */
  stageThumbUrl: string | null;
  stageName: string | null;
  /** Every game in the item's scope. */
  wins: number;
  losses: number;
  total: number;
  /** The chip the engine's formNow read maps to; `null` when the recent window IS all games. */
  chip: DeltaChipView | null;
  /** The recent window's own record, for the chip's accessible name. */
  recentWins: number;
  recentLosses: number;
  /** The last {@link TRACKED_STRIP_GAMES} games in scope, oldest first, never padded. */
  strip: MiniStripGame[];
  /** Plan 39.2-12 (D-05): the class change since this device's last digest, when the item genuinely moved. */
  movedToken: DigestMovedToken | null;
}

/** One moved item as the digest computed it: the token the row shows and the engine salience that orders it. */
export interface TrackedMovedEntry {
  token: DigestMovedToken;
  salience: number;
}

export interface BuildTrackedRowsInput {
  entries: readonly WatchlistEntry[];
  /** The subject's games with opponent aliases already applied (`useFilteredMatches().allMatches`). */
  matches: Match[];
  /** The subject's alias to canonical map. */
  aliasMap: Record<string, string>;
  horizon: HorizonKey;
  nowMs: number;
  t: TFunction;
  /**
   * The chip's horizon is named by the page's one switch on the Tracked section
   * (default). The digest's rows read at their own fixed horizon, so they name it.
   */
  horizonOwnedByParent?: boolean;
  /** Moved items by stored item key (the digest's D-05 read); absent or empty means nothing moved. */
  moved?: ReadonlyMap<string, TrackedMovedEntry>;
}

/** The identity an item collapses under for display: an opponent by its resolved identity, anything else by its own key. */
function displayIdentityKey(
  entry: WatchlistEntry,
  resolveIdentity: (tag: string) => string,
): string {
  const { item, itemKey } = entry;
  return item.kind === 'opponent' ? `opponent:${resolveIdentity(item.ref)}` : itemKey;
}

/**
 * E7 (read side): an item tracked under a tag that has since been merged into
 * another identity displays ONCE, under the resolved identity. Both stored
 * items remain in the watchlist (nothing is rewritten); only the display
 * collapses. The entry whose own key already IS the resolved identity wins the
 * row, else the oldest tracked.
 */
export function dedupeTrackedEntries(
  entries: readonly WatchlistEntry[],
  matches: Match[],
  aliasMap: Record<string, string>,
): Array<{ entry: WatchlistEntry; itemKeys: string[]; identity: string }> {
  const resolve = resolveOpponentIdentities(matches, aliasMap);
  const resolveIdentity = (tag: string): string => resolve({ opponent: tag });
  const groups = new Map<string, WatchlistEntry[]>();
  for (const entry of entries) {
    const key = displayIdentityKey(entry, resolveIdentity);
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  return [...groups.entries()].map(([identityKey, members]) => {
    const own = members.find((member) => member.itemKey === identityKey);
    const primary =
      own ?? [...members].sort((a, b) => a.item.createdAt - b.item.createdAt)[0] ?? members[0]!;
    return {
      entry: primary,
      itemKeys: members.map((member) => member.itemKey),
      identity: identityKey.startsWith('opponent:')
        ? identityKey.slice('opponent:'.length)
        : identityKey,
    };
  });
}

function fighterLabel(id: number, t: TFunction): string {
  const name = localizedFighterName(id, t);
  return name.length > 0 ? name : String(id);
}

/**
 * Builds the sorted Tracked rows: one per display identity, moved items first
 * (engine salience, plan 39.2-12) and then most games in scope. Direction is NEVER computed
 * here (D-05): the chip is `deltaChipView` over the engine's own `formNow` read
 * at the item's `trackedItemScope`, at the page's horizon.
 */
export function buildTrackedRows(input: BuildTrackedRowsInput): TrackedRowModel[] {
  const {
    entries,
    matches,
    aliasMap,
    horizon,
    nowMs,
    t,
    horizonOwnedByParent = true,
    moved,
  } = input;
  const rows = dedupeTrackedEntries(entries, matches, aliasMap).map(
    ({ entry, itemKeys, identity }): TrackedRowModel => {
      // The stored ref may be an alias; the scope is always built on the resolved identity.
      const item: WatchlistItem =
        entry.item.kind === 'opponent' ? { ...entry.item, ref: identity } : entry.item;
      const scope = trackedItemScope(item);
      const scoped = scope.filter(matches);
      const rate = toRateValue(scoped);
      const insight = FORM_NOW_TEMPLATE.build({ matches, scope, horizon, nowMs })[0];
      const recentGames = insight?.window.games ?? 0;
      const chip = deltaChipView({
        state: insight?.state ?? 'locked',
        deltaPoints: insight?.deltaPoints ?? null,
        recentGames,
        horizon,
        // The page's one HorizonSwitch names the horizon for every row (UI-SPEC 7.8).
        horizonOwnedByParent,
        t,
      });
      const recent = insight?.recent;
      const recentRecord =
        recent?.kind === 'evidenced'
          ? { wins: recent.value.wins, losses: recent.value.losses }
          : { wins: 0, losses: 0 };
      const strip = [...scoped]
        .sort((a, b) => (a.time !== b.time ? a.time - b.time : a.id.localeCompare(b.id)))
        .slice(-TRACKED_STRIP_GAMES)
        .map((match) => ({ key: match.id, won: match.win }));

      let name: string;
      let href: string;
      let stageThumbUrl: string | null = null;
      let stageName: string | null = null;
      if (item.kind === 'opponent') {
        // As recorded: the latest game's own tag keeps its casing; the stored ref is lowercase.
        const latest = [...scoped].sort((a, b) => b.time - a.time)[0];
        name = latest?.opponent && latest.opponent.length > 0 ? latest.opponent : item.ref;
        href = buildOpponentHubPath(name);
      } else if (item.kind === 'matchup') {
        name = t('matchups.pairingHeading', {
          fighter: fighterLabel(item.ref.fighterId, t),
          opponent: fighterLabel(item.ref.vsFighterId, t),
        });
        const search = buildDrillDownSearch({
          fighterId: item.ref.fighterId,
          vsFighterId: item.ref.vsFighterId,
        }).toString();
        href = `/matchups?${search}`;
      } else {
        const stage = getStageById(item.ref);
        name = stage?.name ?? String(item.ref);
        stageName = stage?.name ?? null;
        stageThumbUrl = stage?.url ?? null;
        href = `/stages/${item.ref}`;
      }

      return {
        itemKey: entry.itemKey,
        itemKeys,
        kind: item.kind,
        name,
        href,
        stageThumbUrl,
        stageName,
        wins: rate.wins,
        losses: rate.losses,
        total: rate.total,
        chip,
        recentWins: recentRecord.wins,
        recentLosses: recentRecord.losses,
        strip,
        movedToken: moved?.get(entry.itemKey)?.token ?? null,
      };
    },
  );
  const salienceOf = (row: TrackedRowModel): number => moved?.get(row.itemKey)?.salience ?? 0;
  return rows.sort((a, b) => {
    if ((a.movedToken !== null) !== (b.movedToken !== null)) {
      return a.movedToken !== null ? -1 : 1;
    }
    if (a.movedToken !== null && salienceOf(a) !== salienceOf(b)) {
      return salienceOf(b) - salienceOf(a);
    }
    return b.total !== a.total ? b.total - a.total : a.itemKey.localeCompare(b.itemKey);
  });
}
