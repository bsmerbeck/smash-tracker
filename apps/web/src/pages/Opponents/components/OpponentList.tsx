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

/**
 * Left-column opponent list for the Scouting page: every human opponent
 * faced (`getOpponentRecords`), ranked by games played descending, with a
 * substring search filter. Selecting a row calls `onSelect`. Each row shows
 * a source badge (start.gg-verified / manual / mixed) and a kebab menu with
 * a "Merge into..." action.
 */
export function OpponentList({ matches, selected, onSelect, onRequestMerge }: OpponentListProps) {
  const [query, setQuery] = useState('');

  const opponents = useMemo(() => {
    return [...getOpponentRecords(matches)].sort((a, b) => b.total - a.total);
  }, [matches]);

  const sources = useMemo(() => getOpponentSources(matches), [matches]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) {
      return opponents;
    }
    return opponents.filter((o) => o.opponent.toLowerCase().includes(needle));
  }, [opponents, query]);

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
      </CardHeader>
      <CardContent className="flex-1">
        {filtered.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {opponents.length === 0 ? 'No opponents faced yet.' : 'No opponents match your search.'}
          </p>
        ) : (
          <ul className="flex flex-col gap-1" role="list" aria-label="Opponents">
            {filtered.map((opponent) => (
              <OpponentRow
                key={opponent.opponent}
                opponent={opponent}
                selected={opponent.opponent === selected}
                source={sources.get(opponent.opponent) ?? 'manual'}
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
  onSelect,
  onRequestMerge,
}: {
  opponent: OpponentRecord;
  selected: boolean;
  source: OpponentSource;
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
        className="flex min-w-0 flex-1 items-center gap-2 py-2 text-left text-sm"
      >
        <span className="min-w-0 flex-1 truncate font-medium">{opponent.opponent}</span>
        <OpponentSourceBadge source={source} />
        <span className="text-muted-foreground">
          {opponent.wins}-{opponent.losses}
        </span>
        <span className="w-10 text-right font-medium">{opponent.winRate}%</span>
        <span className="w-14 text-right text-xs text-muted-foreground">
          {opponent.total} game{opponent.total === 1 ? '' : 's'}
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
