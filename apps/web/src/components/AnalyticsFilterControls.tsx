import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useAnalyticsFilter } from '@/hooks/useAnalyticsFilter';
import type { AnalyticsRangeFilter, AnalyticsSourceFilter } from '@/context/AnalyticsFilterContext';
import { cn } from '@/lib/utils';

const RANGE_LABELS: Record<AnalyticsRangeFilter, string> = {
  all: 'All time',
  '3m': '3m',
  '6m': '6m',
  '12m': '12m',
};

/**
 * The global analytics filter control surface: a source segmented toggle
 * (All / Casual / Competitive) and a time-range select. Rendered compactly
 * in the desktop topbar and again (full-width) inside the mobile nav Sheet.
 */
export function AnalyticsFilterControls({ className }: { className?: string }) {
  const { source, range, setSource, setRange } = useAnalyticsFilter();

  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
      <ToggleGroup
        type="single"
        variant="outline"
        size="sm"
        value={source}
        onValueChange={(next) => {
          if (next) {
            setSource(next as AnalyticsSourceFilter);
          }
        }}
        aria-label="Filter matches by source"
      >
        <ToggleGroupItem value="all">All</ToggleGroupItem>
        <ToggleGroupItem value="manual">Casual</ToggleGroupItem>
        <ToggleGroupItem value="startgg">Competitive</ToggleGroupItem>
      </ToggleGroup>

      <Select value={range} onValueChange={(next) => setRange(next as AnalyticsRangeFilter)}>
        <SelectTrigger size="sm" aria-label="Filter matches by time range" className="w-[110px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {(Object.keys(RANGE_LABELS) as AnalyticsRangeFilter[]).map((value) => (
            <SelectItem key={value} value={value}>
              {RANGE_LABELS[value]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
