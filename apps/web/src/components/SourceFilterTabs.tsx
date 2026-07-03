import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import type { Match } from '@smash-tracker/shared';

export type MatchSourceFilter = 'all' | 'manual' | 'startgg';

/** Filters matches by origin: manually-entered vs imported from start.gg. */
export function filterBySource(matches: Match[], filter: MatchSourceFilter): Match[] {
  if (filter === 'all') {
    return matches;
  }
  if (filter === 'startgg') {
    return matches.filter((m) => m.source === 'startgg');
  }
  return matches.filter((m) => m.source == null);
}

/** All / Manual / Competitive segmented control shared by data pages. */
export function SourceFilterTabs({
  value,
  onChange,
}: {
  value: MatchSourceFilter;
  onChange: (next: MatchSourceFilter) => void;
}) {
  return (
    <ToggleGroup
      type="single"
      variant="outline"
      size="sm"
      value={value}
      onValueChange={(next) => {
        if (next) {
          onChange(next as MatchSourceFilter);
        }
      }}
      aria-label="Filter matches by source"
    >
      <ToggleGroupItem value="all">All</ToggleGroupItem>
      <ToggleGroupItem value="manual">Manual</ToggleGroupItem>
      <ToggleGroupItem value="startgg">Competitive</ToggleGroupItem>
    </ToggleGroup>
  );
}
