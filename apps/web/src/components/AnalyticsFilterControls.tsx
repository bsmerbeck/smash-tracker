import { useTranslation } from 'react-i18next';
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

const RANGE_LABEL_KEYS: Record<AnalyticsRangeFilter, string> = {
  all: 'filters.allTime',
  '3m': 'filters.months3',
  '6m': 'filters.months6',
  '12m': 'filters.months12',
};

/**
 * The global analytics filter control surface: a source segmented toggle
 * (All / Casual / Competitive) and a time-range select. Rendered compactly
 * in the desktop topbar and again (full-width) inside the mobile nav Sheet.
 */
export function AnalyticsFilterControls({ className }: { className?: string }) {
  const { t } = useTranslation();
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
        aria-label={t('filters.sourceAria')}
      >
        <ToggleGroupItem value="all">{t('filters.all')}</ToggleGroupItem>
        <ToggleGroupItem value="manual">{t('common.casual')}</ToggleGroupItem>
        <ToggleGroupItem value="startgg">{t('common.competitive')}</ToggleGroupItem>
      </ToggleGroup>

      <Select value={range} onValueChange={(next) => setRange(next as AnalyticsRangeFilter)}>
        <SelectTrigger size="sm" aria-label={t('filters.rangeAria')} className="w-[110px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {(Object.keys(RANGE_LABEL_KEYS) as AnalyticsRangeFilter[]).map((value) => (
            <SelectItem key={value} value={value}>
              {t(RANGE_LABEL_KEYS[value])}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
