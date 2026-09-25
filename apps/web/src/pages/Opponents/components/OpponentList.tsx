import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MoreVertical, Search } from 'lucide-react';
import type { Match } from '@smash-tracker/shared';
import {
  ABSTENTION_FLOOR_GAMES,
  classify,
  toRateValue,
  type RateValue,
} from '@smash-tracker/shared';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Toggle } from '@/components/ui/toggle';
import { buildOpponentEvidence, type OpponentEvidenceRow } from '@/lib/stats';
import { SampleCue, SampleCueGlyph } from '@/components/EvidenceCues';
import { DrillableRow, DrillableRowChevron } from '@/components/DrillableRow';
import { LIST_PASS_MAX, LIST_PASS_STEP } from '@/components/analytics/BoundedList';
// Aliased: this file already uses TypeScript's built-in `Record<K, V>` utility
// type (`aliasMap`, `SORT_LABEL_KEYS`) — importing the analytics primitive
// under its own name would shadow that global type.
import { Record as RecordFigure } from '@/components/analytics/Record';
import { DeltaChip, type DeltaChipState } from '@/components/analytics/DeltaChip';
import { OpponentSourceBadge } from './OpponentSourceBadge';

export interface OpponentListProps {
  matches: Match[];
  selected: string | null;
  onSelect: (opponent: string) => void;
  /** Opens the "Merge into..." dialog for the given opponent name. */
  onRequestMerge: (opponent: string) => void;
  /** EVID-12: alias -> canonical map, required so this list's identity resolution can never forget to pre-alias (D-16). */
  aliasMap: Record<string, string>;
  /**
   * Phase 38-07 (C3-M-01): host-supplied hub destination builder. With one
   * supplied, a row is a real anchor into that opponent's hub. With none
   * supplied, the row keeps EXACTLY today's selection-button branch
   * (`onSelect`, `aria-pressed` and all) — this component calls no router
   * hook and no query hook itself either way, so its own bare test renders
   * never need a `MemoryRouter`.
   */
  hubHref?: (row: OpponentEvidenceRow) => string;
}

/** Sort orders for the opponent list. */
export type OpponentSort = 'most-played' | 'recent' | 'best-rate' | 'worst-rate' | 'alphabetical';

const SORT_LABEL_KEYS: Record<OpponentSort, string> = {
  'most-played': 'opponents.list.sortMostPlayed',
  recent: 'opponents.list.sortRecent',
  'best-rate': 'opponents.list.sortBestRate',
  'worst-rate': 'opponents.list.sortWorstRate',
  alphabetical: 'opponents.list.sortAlphabetical',
};

function sortOpponents(
  opponents: OpponentEvidenceRow[],
  sort: OpponentSort,
): OpponentEvidenceRow[] {
  const sorted = [...opponents];
  switch (sort) {
    case 'recent':
      sorted.sort((a, b) => b.lastPlayedAt - a.lastPlayedAt);
      break;
    case 'best-rate':
      sorted.sort((a, b) => b.winRate - a.winRate || b.total - a.total);
      break;
    case 'worst-rate':
      sorted.sort((a, b) => a.winRate - b.winRate || b.total - a.total);
      break;
    case 'alphabetical':
      sorted.sort((a, b) => a.displayTag.localeCompare(b.displayTag));
      break;
    case 'most-played':
    default:
      sorted.sort((a, b) => b.total - a.total);
      break;
  }
  return sorted;
}

/**
 * Left-column opponent list for the Scouting page: every human opponent
 * faced, with a substring search filter, a sort selector (most played /
 * recently played / highest / lowest win rate / alphabetical), and a "3+
 * games" toggle that hides small samples. Selecting a row calls `onSelect`.
 * Each row shows a source badge and a kebab menu with a "Merge into..."
 * action.
 *
 * Phase 36 (EVID-12, R2-BLOCKER-1): rows now come from the identity-resolving
 * `buildOpponentEvidence` (aliased + normalized + slug/parry-id bound) rather
 * than the raw-tag `getOpponentRecords`, so one person recorded under two
 * tags merges into ONE row. `buildOpponentEvidence` is an inventory and
 * applies NO sample floor — this migration changes which rows are MERGED,
 * never which people are LISTED. The small-sample toggle (`minGamesOnly`)
 * stays the ONLY thing that hides a row below the floor, keeps its opt-in
 * `useState(false)` default, and the header count keeps reflecting everyone
 * faced regardless of the toggle. Each row also carries a sample cue — a raw
 * win/loss count is the recorded FACT, so this surface deliberately carries
 * no evidence-type caption (the UI-SPEC's documented conservative default).
 *
 * Plan 39.1-17 (UIX-03, owner note 1): the row is two lines with exactly one
 * flexible truncating slot (the tag). UIX-02: bounded at the per-pass rule
 * (`LIST_PASS_MAX`, +`LIST_PASS_STEP` per "show more" click) — this list has
 * no other pagination mechanism, unlike `MatchTable.tsx`'s TanStack pager.
 */
export function OpponentList({
  matches,
  selected,
  onSelect,
  onRequestMerge,
  aliasMap,
  hubHref,
}: OpponentListProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<OpponentSort>('most-played');
  const [minGamesOnly, setMinGamesOnly] = useState(false);
  // React Compiler forbids a bare `Date.now()` call in the render body (it's
  // impure) — a lazy `useState` initializer is the sanctioned one-time-read
  // escape hatch, matching `CounterpickAdvisor.tsx`'s convention.
  const [refreshedAt] = useState(() => Date.now());

  // Phase 38-05 (D-10): `buildOpponentEvidence`'s own `unnamed` bucket — games
  // with no human-readable identity at all — is computed here since Phase 36
  // but rendered by NO surface until now. Read from the SAME call `opponents`
  // already makes; never a second `buildOpponentEvidence` invocation.
  const evidence = useMemo(
    () => buildOpponentEvidence({ matches, aliasMap, refreshedAt }),
    [matches, aliasMap, refreshedAt],
  );
  const opponents = evidence.rows;
  const unnamed = evidence.unnamed;

  // Plan 39.1-17: whole-account baseline this row's own record is classified
  // against (T-39.1-17-04-adjacent — this is NOT the Dashboard's two-horizon
  // engine read, just the same `classify()` ladder already used by
  // `PairingOpponentRow.tsx` to decide "is this opponent unusual for me").
  const overallRate = useMemo(() => toRateValue(matches), [matches]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const searched = needle
      ? opponents.filter((o) => o.displayTag.toLowerCase().includes(needle))
      : opponents;
    const thresholded = minGamesOnly
      ? searched.filter((o) => o.total >= ABSTENTION_FLOOR_GAMES)
      : searched;
    return sortOpponents(thresholded, sort);
  }, [opponents, query, sort, minGamesOnly]);

  // UIX-02: at most `LIST_PASS_MAX` rows render per pass; "Show 50 more"
  // reveals another `LIST_PASS_STEP`. Not resynced when `filtered` shrinks —
  // the same one-time-initializer limitation `BoundedList`'s own
  // `mode="full-page"` branch has (see its `visibleCount` state).
  const [visibleCount, setVisibleCount] = useState(() => Math.min(LIST_PASS_MAX, filtered.length));
  const visibleFiltered = filtered.slice(0, Math.min(visibleCount, filtered.length));
  const hasMoreRows = visibleCount < filtered.length;

  return (
    <Card className="flex h-full flex-col">
      <CardHeader className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <CardTitle>{t('opponents.list.title')}</CardTitle>
          <span className="text-sm text-muted-foreground">
            {t('opponents.list.faced', { count: opponents.length })}
          </span>
        </div>
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('opponents.list.searchPlaceholder')}
            aria-label={t('opponents.list.searchAria')}
            className="pl-8"
          />
        </div>
        <div className="flex items-center gap-2">
          <Select value={sort} onValueChange={(value) => setSort(value as OpponentSort)}>
            <SelectTrigger className="h-8 flex-1" aria-label={t('opponents.list.sortAria')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(SORT_LABEL_KEYS) as OpponentSort[]).map((key) => (
                <SelectItem key={key} value={key}>
                  {t(SORT_LABEL_KEYS[key])}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Toggle
            size="sm"
            variant="outline"
            pressed={minGamesOnly}
            onPressedChange={setMinGamesOnly}
            aria-label={t('opponents.list.minGamesAria')}
          >
            {t('opponents.list.minGames')}
          </Toggle>
        </div>
      </CardHeader>
      <CardContent className="flex-1">
        {filtered.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {opponents.length === 0
              ? t('opponents.list.emptyNone')
              : t('opponents.list.emptyFiltered')}
          </p>
        ) : (
          <>
            <ul className="flex flex-col gap-1" role="list" aria-label={t('opponents.list.title')}>
              {visibleFiltered.map((opponent) => (
                <OpponentRow
                  key={opponent.identity}
                  opponent={opponent}
                  selected={opponent.displayTag === selected}
                  lastPlayedAt={sort === 'recent' ? opponent.lastPlayedAt : undefined}
                  onSelect={onSelect}
                  onRequestMerge={onRequestMerge}
                  destination={hubHref?.(opponent)}
                  overallRate={overallRate}
                />
              ))}
            </ul>
            {hasMoreRows && (
              <div className="mt-2">
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  onClick={() =>
                    setVisibleCount((v) => Math.min(v + LIST_PASS_STEP, filtered.length))
                  }
                >
                  {t('analytics.list.showMore50')}
                </Button>
              </div>
            )}
          </>
        )}
        {/* D-10: a disclosed FACT, never a ranked row and never clickable — excluded from every opponent ranking. */}
        {unnamed && (
          <p className="mt-2 text-xs text-muted-foreground">
            {t('shared.evidence.unnamedBucket', { count: unnamed.games })}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Plan 39.1-17 (UIX-03): real CSS-driven truncation detection for the row's
 * ONE flexible slot — never a JavaScript character-count slice
 * (T-39.1-17-01). Compares the rendered span's own `scrollWidth` against its
 * `clientWidth`; only when they diverge is the text genuinely clipped by
 * `truncate`'s `text-overflow: ellipsis`, and only then does the element
 * carry a `title` with the full string. A `ResizeObserver` keeps the
 * measurement current as the row's own width changes.
 */
function useTruncationGuard<T extends HTMLElement>(measureKey: string) {
  const ref = useRef<T>(null);
  const [isTruncated, setIsTruncated] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) {
      return undefined;
    }
    const measure = () => setIsTruncated(el.scrollWidth > el.clientWidth);
    measure();
    if (typeof ResizeObserver === 'undefined') {
      return undefined;
    }
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [measureKey]);
  return { ref, isTruncated };
}

/**
 * Plan 39.1-17 (UIX-03 §6.5 rule 8, container-query priority drop): the
 * row's OWN rendered width, JS-measured rather than pure CSS `@container`
 * (unlike `RosterUsage.tsx`/`PairingOpponentRow`'s `@max-[Npx]` classes) —
 * this row's acceptance criteria require a committed, falsifiable unit test
 * proving the exact swap at named thresholds, and jsdom never evaluates a
 * real container query, so a CSS-only implementation would leave this
 * specific contract unverifiable by anything but the deferred real-browser
 * `guard:layout` harness. Mirrors `useTruncationGuard`'s same real-DOM
 * measurement technique.
 */
function useElementWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) {
      return undefined;
    }
    const measure = () => setWidth(el.clientWidth);
    measure();
    if (typeof ResizeObserver === 'undefined') {
      return undefined;
    }
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return { ref, width };
}

/** Below this meta-line width the confidence sentence becomes the glyph (dots + full-sentence `aria-label`). */
const OPPONENT_ROW_SENTENCE_THRESHOLD_PX = 380;
/** Below this meta-line width the record leaves the row entirely, staying reachable via the badge's own tooltip. */
const OPPONENT_ROW_RECORD_THRESHOLD_PX = 260;

const EN_DASH = '–';

/** `classify`'s `InsightState` -> `DeltaChip`'s state union, duplicated per this codebase's small-helper convention (`PairingOpponentRow`'s `deltaChipStateFor` is its own private, unexported function). Only `trend`/`suggestion` are "notable" here — every other state renders no chip at all (never `DeltaChip`'s own `steady`/`thin`/`collapsed` variants), since this row has no room for a non-notable delta. */
function isNotableState(state: ReturnType<typeof classify>['state']): boolean {
  return state === 'trend' || state === 'suggestion';
}

/** Plan 39.1-17 (UIX-03): exported so `OpponentRow.narrowContainer.test.tsx` can render the row in isolation at a fixed container width. */
export interface OpponentRowProps {
  opponent: OpponentEvidenceRow;
  selected: boolean;
  /** Set only under the "Recently played" sort — renders a date hint. */
  lastPlayedAt?: number;
  onSelect: (opponent: string) => void;
  onRequestMerge: (opponent: string) => void;
  /** Phase 38-07 (C3-M-01): the host-built hub destination for this row, or `undefined` when the host supplies no `hubHref` — in which case the row keeps today's in-page selection-button behavior. */
  destination?: string;
  /** Plan 39.1-17: the whole-account baseline this row's own record is classified against for the delta chip. */
  overallRate: RateValue;
}

export function OpponentRow({
  opponent,
  selected,
  lastPlayedAt,
  onSelect,
  onRequestMerge,
  destination,
  overallRate,
}: OpponentRowProps) {
  const { t, i18n } = useTranslation();
  const { ref: tagRef, isTruncated } = useTruncationGuard<HTMLSpanElement>(opponent.displayTag);
  const { ref: metaRef, width: metaWidth } = useElementWidth<HTMLDivElement>();

  const showSentence = metaWidth >= OPPONENT_ROW_SENTENCE_THRESHOLD_PX;
  const showRecord = metaWidth === 0 || metaWidth >= OPPONENT_ROW_RECORD_THRESHOLD_PX;

  const showRate = opponent.total >= ABSTENTION_FLOOR_GAMES;
  const recordTooltip = showRate
    ? `${opponent.wins}${EN_DASH}${opponent.losses} · ${opponent.winRate}% · ${opponent.total}`
    : `${opponent.wins}${EN_DASH}${opponent.losses} · ${opponent.total}`;

  const recentRate: RateValue = {
    wins: opponent.wins,
    losses: opponent.losses,
    total: opponent.total,
    rate: opponent.winRate / 100,
  };
  const { state: classifyState, deltaPoints } = classify({
    recent: recentRate,
    baseline: overallRate,
    scoped: false,
    hasAction: false,
  });
  const notable = isNotableState(classifyState);
  const chipState: DeltaChipState = deltaPoints !== null && deltaPoints < 0 ? 'down' : 'up';
  const recordText = `${opponent.wins}${EN_DASH}${opponent.losses}`;
  const baselineRecordText = `${overallRate.wins}${EN_DASH}${overallRate.losses}`;

  const rowBody = (
    <>
      {/* Line 1: the ONE flexible truncating slot (the tag) plus nothing else — the kebab menu is a row-level sibling, not part of this flex-col group. */}
      <span
        ref={tagRef}
        className="min-w-0 truncate font-medium"
        data-truncate-guard
        title={isTruncated ? opponent.displayTag : undefined}
      >
        {opponent.displayTag}
      </span>
      {/* Line 2: a wrapping meta line — every token wraps WHOLE, never mid-token. */}
      <div
        ref={metaRef}
        className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground"
        data-slot="opponent-row-meta"
      >
        <span title={recordTooltip}>
          <OpponentSourceBadge source={opponent.source} />
        </span>
        {showRecord && (
          <span className="tabular-nums whitespace-nowrap">
            <RecordFigure
              wins={opponent.wins}
              losses={opponent.losses}
              cue="none"
              locale={i18n.language}
            />
          </span>
        )}
        {showSentence ? (
          <SampleCue sample={opponent.sample} />
        ) : (
          <SampleCueGlyph sample={opponent.sample} />
        )}
        {notable && (
          <DeltaChip
            state={chipState}
            valueLabel={t(
              chipState === 'up' ? 'analytics.record.deltaUp' : 'analytics.record.deltaDown',
              { points: Math.abs(deltaPoints ?? 0) },
            )}
            horizonOwnedByParent
            ariaLabel={t('analytics.dumbbell.rowAria', {
              label: opponent.displayTag,
              recentRecord: recordText,
              baselineRecord: baselineRecordText,
            })}
          />
        )}
        {lastPlayedAt != null && (
          <span>{new Date(lastPlayedAt).toLocaleDateString(i18n.language)}</span>
        )}
      </div>
    </>
  );

  return (
    <li
      className={`relative flex items-center gap-1 rounded-md border px-1 transition-colors ${
        selected ? 'border-primary bg-primary/10' : 'border-transparent hover:bg-accent'
      }`}
    >
      {destination != null ? (
        <>
          <DrillableRow
            as="overlay"
            to={destination}
            ariaLabel={t('shared.drillableRow.aria', {
              subject: opponent.displayTag,
              context: t('opponents.list.title'),
            })}
          />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5 py-2 text-left text-sm">
            {rowBody}
          </div>
          <DrillableRowChevron />
        </>
      ) : (
        <button
          type="button"
          onClick={() => onSelect(opponent.displayTag)}
          aria-pressed={selected}
          className="flex min-w-0 flex-1 flex-col gap-0.5 py-2 text-left text-sm"
        >
          {rowBody}
        </button>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t('opponents.list.rowActions', { name: opponent.displayTag })}
          >
            <MoreVertical className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => onRequestMerge(opponent.displayTag)}>
            {t('opponents.list.mergeInto')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}
