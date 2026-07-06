import { useMemo, useState } from 'react';
import { MoreVertical, Search } from 'lucide-react';
import type { Match } from '@smash-tracker/shared';
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
import { getOpponentRecords, type OpponentRecord } from '@/lib/stats';
import { getOpponentSources, type OpponentSource } from '@/hooks/useFilteredMatches';
import { OpponentSourceBadge } from './OpponentSourceBadge';

export interface OpponentListProps {
  matches: Match[];
  selected: string | null;
  onSelect: (opponent: string) => void;
  /** Opens the "Merge into..." dialog for the given opponent name. */
  onRequestMerge: (opponent: string) => void;
}

/** Sort orders for the opponent list. */
export type OpponentSort = 'most-played' | 'recent' | 'best-rate' | 'worst-rate' | 'alphabetical';

const SORT_LABELS: Record<OpponentSort, string> = {
  'most-played': 'Most played',
  recent: 'Recently played',
  'best-rate': 'Highest win rate',
  'worst-rate': 'Lowest win rate',
  alphabetical: 'A → Z',
};

/** Games threshold applied by the "3+ games" small-sample toggle. */
const MIN_GAMES = 3;

function sortOpponents(
  opponents: OpponentRecord[],
  sort: OpponentSort,
  lastPlayed: Map<string, number>,
): OpponentRecord[] {
  const sorted = [...opponents];
  switch (sort) {
    case 'recent':
      sorted.sort((a, b) => (lastPlayed.get(b.opponent) ?? 0) - (lastPlayed.get(a.opponent) ?? 0));
      break;
    case 'best-rate':
      sorted.sort((a, b) => b.winRate - a.winRate || b.total - a.total);
      break;
    case 'worst-rate':
      sorted.sort((a, b) => a.winRate - b.winRate || b.total - a.total);
      break;
    case 'alphabetical':
      sorted.sort((a, b) => a.opponent.localeCompare(b.opponent));
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
 * faced (`getOpponentRecords`), with a substring search filter, a sort
 * selector (most played / recently played / highest / lowest win rate /
 * alphabetical), and a "3+ games" toggle that hides small samples.
 * Selecting a row calls `onSelect`. Each row shows a source badge and a
 * kebab menu with a "Merge into..." action.
 */
export function OpponentList({ matches, selected, onSelect, onRequestMerge }: OpponentListProps) {
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<OpponentSort>('most-played');
  const [minGamesOnly, setMinGamesOnly] = useState(false);

  const opponents = useMemo(() => getOpponentRecords(matches), [matches]);

  const sources = useMemo(() => getOpponentSources(matches), [matches]);

  // Most recent match time per opponent name — drives the "Recently played"
  // sort. Matches arrive already alias-canonicalized upstream.
  const lastPlayed = useMemo(() => {
    const map = new Map<string, number>();
    for (const match of matches) {
      if (!match.opponent) {
        continue;
      }
      const prev = map.get(match.opponent) ?? 0;
      if (match.time > prev) {
        map.set(match.opponent, match.time);
      }
    }
    return map;
  }, [matches]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const searched = needle
      ? opponents.filter((o) => o.opponent.toLowerCase().includes(needle))
      : opponents;
    const thresholded = minGamesOnly ? searched.filter((o) => o.total >= MIN_GAMES) : searched;
    return sortOpponents(thresholded, sort, lastPlayed);
  }, [opponents, query, sort, minGamesOnly, lastPlayed]);

  return (
    <Card className="flex h-full flex-col">
      <CardHeader className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <CardTitle>Opponents</CardTitle>
          <span className="text-sm text-muted-foreground">
            {opponents.length} opponent{opponents.length === 1 ? '' : 's'} faced
          </span>
        </div>
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search opponents..."
            aria-label="Search opponents"
            className="pl-8"
          />
        </div>
        <div className="flex items-center gap-2">
          <Select value={sort} onValueChange={(value) => setSort(value as OpponentSort)}>
            <SelectTrigger className="h-8 flex-1" aria-label="Sort opponents">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(SORT_LABELS) as OpponentSort[]).map((key) => (
                <SelectItem key={key} value={key}>
                  {SORT_LABELS[key]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Toggle
            size="sm"
            variant="outline"
            pressed={minGamesOnly}
            onPressedChange={setMinGamesOnly}
            aria-label="Only show opponents with 3 or more games"
          >
            3+ games
          </Toggle>
        </div>
      </CardHeader>
      <CardContent className="flex-1">
        {filtered.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {opponents.length === 0
              ? 'No opponents faced yet.'
              : 'No opponents match your filters.'}
          </p>
        ) : (
          <ul className="flex flex-col gap-1" role="list" aria-label="Opponents">
            {filtered.map((opponent) => (
              <OpponentRow
                key={opponent.opponent}
                opponent={opponent}
                selected={opponent.opponent === selected}
                source={sources.get(opponent.opponent) ?? 'manual'}
                lastPlayedAt={sort === 'recent' ? lastPlayed.get(opponent.opponent) : undefined}
                onSelect={onSelect}
                onRequestMerge={onRequestMerge}
              />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function OpponentRow({
  opponent,
  selected,
  source,
  lastPlayedAt,
  onSelect,
  onRequestMerge,
}: {
  opponent: OpponentRecord;
  selected: boolean;
  source: OpponentSource;
  /** Set only under the "Recently played" sort — renders a date hint. */
  lastPlayedAt?: number;
  onSelect: (opponent: string) => void;
  onRequestMerge: (opponent: string) => void;
}) {
  return (
    <li
      className={`flex items-center gap-1 rounded-md border px-1 transition-colors ${
        selected ? 'border-primary bg-primary/10' : 'border-transparent hover:bg-accent'
      }`}
    >
      <button
        type="button"
        onClick={() => onSelect(opponent.opponent)}
        aria-pressed={selected}
        className="flex min-w-0 flex-1 flex-col gap-0.5 py-2 text-left text-sm"
      >
        {/* Name owns the full first line so badges/stats can never squeeze it out. */}
        <span className="min-w-0 truncate font-medium" title={opponent.opponent}>
          {opponent.opponent}
        </span>
        <span className="flex items-center gap-2">
          <OpponentSourceBadge source={source} />
          <span className="text-muted-foreground">
            {opponent.wins}-{opponent.losses}
          </span>
          <span className="font-medium">{opponent.winRate}%</span>
          <span className="text-xs text-muted-foreground">
            {opponent.total} game{opponent.total === 1 ? '' : 's'}
          </span>
          {lastPlayedAt != null && (
            <span className="text-xs text-muted-foreground">
              {new Date(lastPlayedAt).toLocaleDateString()}
            </span>
          )}
        </span>
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`Actions for ${opponent.opponent}`}
          >
            <MoreVertical className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => onRequestMerge(opponent.opponent)}>
            Merge into...
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}
