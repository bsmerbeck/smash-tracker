import { useId, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { TIER_WORDS, type TierWord } from '@smash-tracker/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { Toggle } from '@/components/ui/toggle';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { MUTED_LINK_TONE } from '@/components/analytics/linkTone';
import { useRowLayout, type RowLayout } from '@/hooks/useRowLayout';
import {
  activeTierFilterCount,
  buildTierFilterSearch,
  readTierFilterParams,
  type TierFilters,
  type TierFilterSetting,
} from '@/lib/tierFilterParams';
import { cn } from '@/lib/utils';

export interface TierFilterChipsProps {
  /** Faceted counts per tier word (each ignores the tier selection itself). Every word present, zeros included. */
  tierCounts: Record<TierWord, number>;
  /** Faceted counts per setting (each ignores the setting selection itself). */
  settingCounts: Record<TierFilterSetting, number>;
  /** Forces one layout (tests / hosts); otherwise read once from the viewport (below 640px: the Sheet). */
  layout?: RowLayout;
}

const SETTINGS: readonly TierFilterSetting[] = ['offline', 'online'];

/** The `overline` role (UI-SPEC §5). */
const OVERLINE =
  'text-[0.6875rem] leading-4 font-semibold tracking-wider text-muted-foreground uppercase';

/**
 * UI-SPEC §7.3 chip anatomy: `h-8 px-3 rounded-full border text-sm`. A pressed
 * chip is NEUTRAL (rule 10) — never the brand colour — and a disabled chip
 * drops to half opacity.
 */
const CHIP_CLASS =
  'h-8 rounded-full border border-input bg-transparent px-3 text-sm whitespace-nowrap hover:bg-muted/40 data-[state=on]:border-foreground/40 data-[state=on]:bg-muted data-[state=on]:text-foreground aria-disabled:opacity-50';

/** `filters` with the setting replaced (or removed): an absent setting is an ABSENT key, never `undefined`. */
function withSetting(filters: TierFilters, setting: TierFilterSetting | undefined): TierFilters {
  const next: TierFilters = { tiers: filters.tiers };
  if (filters.side != null) {
    next.side = filters.side;
  }
  if (setting != null) {
    next.setting = setting;
  }
  return next;
}

/** `filters` with the side-event mode replaced (or removed). */
function withSide(filters: TierFilters, side: TierFilters['side']): TierFilters {
  const next: TierFilters = { tiers: filters.tiers };
  if (filters.setting != null) {
    next.setting = filters.setting;
  }
  if (side != null) {
    next.side = side;
  }
  return next;
}

interface ChipProps {
  label: string;
  count: number;
  /** A zero-count chip that is not pressed is disabled, never hidden; a pressed one stays operable so it can be released. */
  disabled: boolean;
  noneLabel: string;
}

function ChipLabel({ label, count }: { label: string; count: number }) {
  const { t } = useTranslation();
  return <span className="tabular-nums">{t('tiers.filter.chip', { label, count })}</span>;
}

function GroupLabel({ id, text, note }: { id: string; text: string; note: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span id={id} tabIndex={0} className={cn('cursor-default', OVERLINE)}>
          {text}
        </span>
      </TooltipTrigger>
      <TooltipContent>{note}</TooltipContent>
    </Tooltip>
  );
}

/** One chip, wrapped in the "none in this range" tooltip when it is disabled (a disabled button raises no pointer events itself). */
function ChipItem({ value, chip }: { value: string; chip: ChipProps }) {
  const item = (
    <ToggleGroupItem
      value={value}
      disabled={chip.disabled}
      aria-disabled={chip.disabled ? true : undefined}
      className={CHIP_CLASS}
    >
      <ChipLabel label={chip.label} count={chip.count} />
    </ToggleGroupItem>
  );
  if (!chip.disabled) {
    return item;
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex">{item}</span>
      </TooltipTrigger>
      <TooltipContent>{chip.noneLabel}</TooltipContent>
    </Tooltip>
  );
}

function ChipGroups({
  filters,
  tierCounts,
  settingCounts,
  onChange,
}: {
  filters: TierFilters;
  tierCounts: Record<TierWord, number>;
  settingCounts: Record<TierFilterSetting, number>;
  onChange: (next: TierFilters) => void;
}) {
  const { t } = useTranslation();
  const tierLabelId = useId();
  const settingLabelId = useId();
  const countsNote = t('tiers.filter.countsNote');

  const tierLabel = (word: TierWord) => t(`tiers.label.${word}`);
  const settingLabel = (setting: TierFilterSetting) => t(`tiers.setting.${setting}`);
  const noneInRange = (label: string) => t('tiers.filter.noneInRange', { label });
  const tierGroupLabel = t('tiers.filter.tierLabel');
  const settingGroupLabel = t('tiers.filter.settingLabel');
  const hideSideEventsLabel = t('tiers.filter.hideSideEvents');

  return (
    <>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <GroupLabel id={tierLabelId} text={tierGroupLabel} note={countsNote} />
        <ToggleGroup
          type="multiple"
          variant="outline"
          size="sm"
          spacing={2}
          aria-labelledby={tierLabelId}
          className="flex-wrap"
          value={filters.tiers}
          onValueChange={(values) =>
            onChange({
              ...filters,
              tiers: TIER_WORDS.filter((word) => values.includes(word)),
            })
          }
        >
          {TIER_WORDS.map((word) => (
            <ChipItem
              key={word}
              value={word}
              chip={{
                label: tierLabel(word),
                count: tierCounts[word],
                disabled: tierCounts[word] === 0 && !filters.tiers.includes(word),
                noneLabel: noneInRange(tierLabel(word)),
              }}
            />
          ))}
        </ToggleGroup>
      </div>

      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <GroupLabel id={settingLabelId} text={settingGroupLabel} note={countsNote} />
        {/* Single-select by intent (deselect = both). Radix's own `single` type
            exposes `role="radio"`; `multiple` keeps every chip a pressed
            toggle button, and the handler below keeps at most one selected. */}
        <ToggleGroup
          type="multiple"
          variant="outline"
          size="sm"
          spacing={2}
          aria-labelledby={settingLabelId}
          className="flex-wrap"
          value={filters.setting ? [filters.setting] : []}
          onValueChange={(values) => {
            const added = values.find((value) => value !== filters.setting);
            const next = SETTINGS.find((setting) => setting === added);
            onChange(withSetting(filters, next));
          }}
        >
          {SETTINGS.map((setting) => (
            <ChipItem
              key={setting}
              value={setting}
              chip={{
                label: settingLabel(setting),
                count: settingCounts[setting],
                disabled: settingCounts[setting] === 0 && filters.setting !== setting,
                noneLabel: noneInRange(settingLabel(setting)),
              }}
            />
          ))}
        </ToggleGroup>
        <Toggle
          variant="outline"
          size="sm"
          className={CHIP_CLASS}
          pressed={filters.side === 'hide'}
          onPressedChange={(pressed) => {
            onChange(withSide(filters, pressed ? 'hide' : undefined));
          }}
        >
          {hideSideEventsLabel}
        </Toggle>
      </div>
    </>
  );
}

/**
 * The Tournaments filter row (D-13, DD-04, UI-SPEC §7.3): tier chips, setting
 * chips and "Hide side events", with faceted counts supplied by the page. The
 * URL is the ONLY state — the chips are read from `useSearchParams` on every
 * render through the one tolerant reader and written back through the one
 * builder with `navigate(..., { replace: true })`, so the back stack is never
 * flooded and nothing reaches device-local storage. Range and source stay in
 * the Topbar's controls.
 *
 * Below 640px the groups move into a Sheet behind "Filters (n)", with the
 * active-filter count as a neutral badge and "Clear filters" in the footer.
 */
export function TierFilterChips({ tierCounts, settingCounts, layout }: TierFilterChipsProps) {
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { hash } = useLocation();
  const resolvedLayout = useRowLayout(layout);
  const [sheetOpen, setSheetOpen] = useState(false);

  const filters = readTierFilterParams(searchParams);
  const activeCount = activeTierFilterCount(filters);

  const write = (next: TierFilters) => {
    navigate(
      { search: buildTierFilterSearch(next, searchParams).toString(), hash },
      { replace: true },
    );
  };

  const groups = (
    <ChipGroups
      filters={filters}
      tierCounts={tierCounts}
      settingCounts={settingCounts}
      onChange={write}
    />
  );
  const clearButton = (
    <Button
      type="button"
      variant="link"
      size="sm"
      className={MUTED_LINK_TONE}
      onClick={() => write({ tiers: [] })}
    >
      {t('tiers.filter.clear')}
    </Button>
  );

  if (resolvedLayout === 'stack') {
    return (
      <div data-slot="tier-filter-chips" data-layout="sheet" className="flex items-center gap-2">
        <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
          <SheetTrigger asChild>
            <Button type="button" variant="outline" size="sm">
              {t('tiers.filter.sheetButton')}
              {activeCount > 0 && <Badge variant="secondary">{activeCount}</Badge>}
            </Button>
          </SheetTrigger>
          <SheetContent side="right">
            <SheetHeader>
              <SheetTitle>{t('tiers.filter.sheetButton')}</SheetTitle>
              <SheetDescription>{t('tiers.filter.countsNote')}</SheetDescription>
            </SheetHeader>
            <div className="flex flex-col gap-4 px-4">{groups}</div>
            {activeCount > 0 && <SheetFooter>{clearButton}</SheetFooter>}
          </SheetContent>
        </Sheet>
      </div>
    );
  }

  return (
    <div
      data-slot="tier-filter-chips"
      data-layout="inline"
      className="flex flex-wrap items-center gap-x-3 gap-y-2"
    >
      {groups}
      {activeCount > 0 && <span className="ml-auto">{clearButton}</span>}
    </div>
  );
}
