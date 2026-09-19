import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MoreVertical, Search } from 'lucide-react';
import type { Match } from '@smash-tracker/shared';
import { ABSTENTION_FLOOR_GAMES } from '@smash-tracker/shared';
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
import { SampleCue } from '@/components/EvidenceCues';
import { DrillableRow, DrillableRowChevron } from '@/components/DrillableRow';
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
          <ul className="flex flex-col gap-1" role="list" aria-label={t('opponents.list.title')}>
            {filtered.map((opponent) => (
              <OpponentRow
                key={opponent.identity}
                opponent={opponent}
                selected={opponent.displayTag === selected}
                lastPlayedAt={sort === 'recent' ? opponent.lastPlayedAt : undefined}
                onSelect={onSelect}
                onRequestMerge={onRequestMerge}
                destination={hubHref?.(opponent)}
              />
            ))}
          </ul>
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

function OpponentRow({
  opponent,
  selected,
  lastPlayedAt,
  onSelect,
  onRequestMerge,
  destination,
}: {
  opponent: OpponentEvidenceRow;
  selected: boolean;
  /** Set only under the "Recently played" sort — renders a date hint. */
  lastPlayedAt?: number;
  onSelect: (opponent: string) => void;
  onRequestMerge: (opponent: string) => void;
  /** Phase 38-07 (C3-M-01): the host-built hub destination for this row, or `undefined` when the host supplies no `hubHref` — in which case the row keeps today's in-page selection-button behavior. */
  destination?: string;
}) {
  const { t, i18n } = useTranslation();
  const rowBody = (
    <>
      {/* Name owns the full first line so badges/stats can never squeeze it out. */}
      <span className="min-w-0 truncate font-medium" title={opponent.displayTag}>
        {opponent.displayTag}
      </span>
      <span className="flex items-center gap-2">
        <OpponentSourceBadge source={opponent.source} />
        <span className="text-muted-foreground">
          {opponent.wins}-{opponent.losses}
        </span>
        <span className="font-medium">{opponent.winRate}%</span>
        <span className="text-xs text-muted-foreground">
          {t('common.games', { count: opponent.total })}
        </span>
        <SampleCue sample={opponent.sample} />
        {lastPlayedAt != null && (
          <span className="text-xs text-muted-foreground">
            {new Date(lastPlayedAt).toLocaleDateString(i18n.language)}
          </span>
        )}
      </span>
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
