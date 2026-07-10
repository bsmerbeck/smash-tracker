import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ChevronsUpDown } from 'lucide-react';
import type { Match } from '@smash-tracker/shared';
import { getFighterById } from '@/data/sprites';
import { ALL_FILTER_VALUE, tournamentLabel } from '@/pages/MatchData/lib/matchTableFilters';
import type { VodManagerFilterState, VodSortDirection } from '../lib/vodManagerFilters';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

type VodManagerFilterOptions = {
  fighters: string[];
  opponentFighters: string[];
  stages: string[];
  tournaments: string[];
  opponents: string[];
};

/**
 * List panel for the VOD Manager (D-06): one dropdown/combobox control per
 * filter dimension (fighter/opponent's character/stage as Select dropdowns,
 * opponent/tournament as searchable comboboxes given higher cardinality),
 * plus the newest/oldest sort toggle (D-08, the only sort dimension). Rows
 * are selectable — clicking a row calls `onSelect(match.id)`, which the
 * parent reflects into `?match=`. Applies the `border-primary text-primary`
 * has-vod accent (every row here always has a VOD, so it's always applied)
 * and `bg-accent text-accent-foreground` when a row is the current selection
 * (mirrors the sidebar active-link treatment, D-13's token pairing).
 */
export function VodMatchList({
  matches,
  filters,
  filterOptions,
  onFiltersChange,
  sort,
  onSortChange,
  selectedId,
  onSelect,
}: {
  matches: Match[];
  filters: VodManagerFilterState;
  filterOptions: VodManagerFilterOptions;
  onFiltersChange: (filters: VodManagerFilterState) => void;
  sort: VodSortDirection;
  onSortChange: (sort: VodSortDirection) => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const { t } = useTranslation();

  function setFilter<K extends keyof VodManagerFilterState>(
    key: K,
    value: VodManagerFilterState[K],
  ) {
    onFiltersChange({ ...filters, [key]: value });
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2">
        <FilterSelect
          label={t('vodManager.filters.fighter')}
          value={filters.fighter}
          options={filterOptions.fighters}
          onChange={(value) => setFilter('fighter', value)}
        />
        <FilterSelect
          label={t('vodManager.filters.opponentFighter')}
          value={filters.opponentFighter}
          options={filterOptions.opponentFighters}
          onChange={(value) => setFilter('opponentFighter', value)}
        />
        <FilterSelect
          label={t('vodManager.filters.stage')}
          value={filters.stage}
          options={filterOptions.stages}
          onChange={(value) => setFilter('stage', value)}
        />
        <FilterCombobox
          label={t('vodManager.filters.opponent')}
          value={filters.opponent}
          options={filterOptions.opponents}
          onChange={(value) => setFilter('opponent', value)}
        />
        <FilterCombobox
          label={t('vodManager.filters.tournament')}
          value={filters.tournament}
          options={filterOptions.tournaments}
          onChange={(value) => setFilter('tournament', value)}
        />
        <Select value={sort} onValueChange={(value) => onSortChange(value as VodSortDirection)}>
          <SelectTrigger className="w-full" aria-label={t('vodManager.filters.allOption')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="newest">{t('vodManager.sort.newest')}</SelectItem>
            <SelectItem value="oldest">{t('vodManager.sort.oldest')}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="flex max-h-[60vh] flex-col gap-1 overflow-y-auto md:max-h-none">
        {matches.map((match) => (
          <MatchRow
            key={match.id}
            match={match}
            isSelected={match.id === selectedId}
            onSelect={() => onSelect(match.id)}
          />
        ))}
      </div>
    </div>
  );
}

function MatchRow({
  match,
  isSelected,
  onSelect,
}: {
  match: Match;
  isSelected: boolean;
  onSelect: () => void;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLButtonElement>(null);

  // Only re-scroll when this row's own selection state flips true — not on
  // every render of the list.
  useEffect(() => {
    if (isSelected) {
      ref.current?.scrollIntoView({ block: 'nearest' });
    }
  }, [isSelected]);

  const fighter = getFighterById(match.fighter_id);
  const opponentFighter = getFighterById(match.opponent_id);
  const opponent = match.opponent || t('common.unknown');

  return (
    <button
      ref={ref}
      type="button"
      onClick={onSelect}
      aria-label={t('vodManager.selectMatchAria', { opponent })}
      className={cn(
        'flex flex-col items-start gap-0.5 rounded-md border border-primary p-2 text-left text-sm text-primary transition-colors hover:bg-accent hover:text-accent-foreground',
        isSelected && 'bg-accent text-accent-foreground',
      )}
    >
      <span className="font-medium">
        {fighter?.name ?? t('common.unknown')} vs {opponentFighter?.name ?? t('common.unknown')}
      </span>
      <span className="text-xs opacity-80">
        {opponent} · {tournamentLabel(match)} · {new Date(match.time).toLocaleDateString()}
      </span>
    </button>
  );
}

/** One dropdown filter, with an "All" reset option prepended. Renders a
 * visible label above the control — the "All" option text alone doesn't
 * identify which dimension a control filters once a real value is selected
 * (human-verify found five indistinguishable "All" dropdowns). */
function FilterSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="w-full" aria-label={label}>
          <SelectValue placeholder={label} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL_FILTER_VALUE}>{t('vodManager.filters.allOption')}</SelectItem>
          {options.map((option) => (
            <SelectItem key={option} value={option}>
              {option}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/** One searchable combobox filter (opponent/tournament — higher cardinality per D-06), with an "All" reset option.
 * Renders a visible label above the control (see FilterSelect doc comment). */
function FilterCombobox({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  const displayValue = value === ALL_FILTER_VALUE ? t('vodManager.filters.allOption') : value;

  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <Popover>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            role="combobox"
            aria-label={label}
            className="w-full justify-between font-normal"
          >
            <span className="truncate">{displayValue}</span>
            <ChevronsUpDown className="opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[--radix-popover-trigger-width] p-0">
          <Command>
            <CommandInput placeholder={label} />
            <CommandList>
              <CommandEmpty>{t('vodManager.filters.allOption')}</CommandEmpty>
              <CommandGroup>
                <CommandItem value={ALL_FILTER_VALUE} onSelect={() => onChange(ALL_FILTER_VALUE)}>
                  <Check className={cn(value === ALL_FILTER_VALUE ? 'opacity-100' : 'opacity-0')} />
                  {t('vodManager.filters.allOption')}
                </CommandItem>
                {options.map((option) => (
                  <CommandItem key={option} value={option} onSelect={() => onChange(option)}>
                    <Check className={cn(value === option ? 'opacity-100' : 'opacity-0')} />
                    {option}
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}
