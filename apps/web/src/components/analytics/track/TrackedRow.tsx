import { Swords, User, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useSubjectPath } from '@/hooks/useSubjectPath';
import { confidenceTierFor } from '@smash-tracker/shared';
import { Button } from '@/components/ui/button';
import { DrillableRow, DrillableRowChevron } from '@/components/DrillableRow';
import { DeltaChip } from '@/components/analytics/DeltaChip';
import { Record } from '@/components/analytics/Record';
import { MiniStrip } from '@/components/charts/inlineMarks';
import { stageAbbreviation } from '@/components/StageOption';
import type { TrackedRowModel } from '@/components/analytics/track/trackedRowModel';

export interface TrackedRowProps {
  model: TrackedRowModel;
  /** Untracks the row; the section owns the focus hand-off. Absent in the compact variant. */
  onUntrack?: (model: TrackedRowModel) => void;
  /** The digest's variant: no strip, no untrack control. */
  compact?: boolean;
}

/** "26–7, 79%" for the accessible name: the rate only from the abstention floor up, as `Record` itself does. */
function recordSentence(wins: number, losses: number, numbers: Intl.NumberFormat): string {
  const total = wins + losses;
  const base = `${numbers.format(wins)}–${numbers.format(losses)}`;
  return total >= 3 ? `${base}, ${Math.round((wins / total) * 100)}%` : base;
}

/** The 32 x 20 stage thumb, or the abbreviation tile a stage without art gets on its own page. */
function StageThumb({ model }: { model: TrackedRowModel }) {
  if (model.stageThumbUrl) {
    return (
      <img
        src={model.stageThumbUrl}
        alt=""
        className="h-5 w-8 shrink-0 rounded-sm object-cover"
        data-slot="tracked-row-stage-thumb"
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      data-slot="tracked-row-stage-thumb"
      className="flex h-5 w-8 shrink-0 items-center justify-center rounded-sm bg-muted text-xs font-semibold text-muted-foreground"
    >
      {model.stageName ? stageAbbreviation(model.stageName) : '??'}
    </span>
  );
}

function KindMark({ model }: { model: TrackedRowModel }) {
  if (model.kind === 'stage') {
    return <StageThumb model={model} />;
  }
  const Icon = model.kind === 'matchup' ? Swords : User;
  return <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />;
}

/**
 * UI-SPEC 7.8: one tracked item as a `DrillableRow` (`as="overlay"`) to the
 * item's own surface. The row never computes a direction (D-05): the chip is
 * the engine's `formNow` read mapped through `deltaChipView` in
 * `buildTrackedRows`. Below a 480px row container the name owns its own line
 * above the metrics (the `PairingOpponents` precedent), then the strip drops
 * below 320px and the chip below 260px; the chip's content stays in the row's
 * accessible name. The untrack button sits above the overlay so a press never
 * navigates.
 */
export function TrackedRow({ model, onUntrack, compact = false }: TrackedRowProps) {
  const { t, i18n } = useTranslation();
  const subjectPath = useSubjectPath();
  const numbers = new Intl.NumberFormat(i18n.language);
  const tier = confidenceTierFor(model.total);
  const cueLabel = tier
    ? t(`shared.evidence.sampleCueGlyph.${tier}`, { count: model.total })
    : undefined;
  const kindLabel = t(`watchlist.kind.${model.kind}`);
  const stateLabel = model.chip ? model.chip.valueLabel : t('analytics.stat.collapsedValue');
  const rowAria = t('watchlist.row.aria', {
    kind: kindLabel,
    name: model.name,
    record: recordSentence(model.wins, model.losses, numbers),
    count: model.total,
    state: stateLabel,
  });
  const chipAria = t('analytics.dumbbell.rowAria', {
    label: model.name,
    recentRecord: `${model.recentWins}–${model.recentLosses}`,
    baselineRecord: `${model.wins}–${model.losses}`,
  });
  const stripAria = t('analytics.strip.aria', {
    count: model.total,
    shown: model.strip.length,
  });
  const untrackAria = t('watchlist.untrackAria', { name: model.name });

  return (
    <li
      data-slot="tracked-row"
      data-kind={model.kind}
      data-item-key={model.itemKey}
      className="@container/tracked-row relative flex items-center gap-2 rounded-md px-2 py-2 hover:bg-accent pointer-coarse:min-h-11"
    >
      <DrillableRow as="overlay" to={subjectPath(model.href)} ariaLabel={rowAria} />
      <KindMark model={model} />
      <div
        data-slot="tracked-row-body"
        className="flex min-w-0 flex-1 flex-col gap-1 @min-[480px]/tracked-row:flex-row @min-[480px]/tracked-row:items-center @min-[480px]/tracked-row:gap-2"
      >
        <span
          data-slot="tracked-row-name"
          className="min-w-0 truncate text-sm font-medium @min-[480px]/tracked-row:flex-1"
          title={model.name}
        >
          {model.name}
        </span>
        <div
          data-slot="tracked-row-metrics"
          className="flex flex-wrap items-center gap-x-2 gap-y-1 @min-[480px]/tracked-row:shrink-0 @min-[480px]/tracked-row:flex-nowrap"
        >
          <span className="shrink-0 text-sm">
            <Record
              wins={model.wins}
              losses={model.losses}
              cue="glyph"
              cueLabel={cueLabel}
              locale={i18n.language}
              wrap
            />
          </span>
          {model.chip && (
            <span className="shrink-0 whitespace-nowrap @max-[260px]/tracked-row:hidden">
              <DeltaChip {...model.chip} ariaLabel={chipAria} />
            </span>
          )}
          {!compact && model.strip.length > 0 && (
            <span className="shrink-0 @max-[320px]/tracked-row:hidden">
              <MiniStrip games={model.strip} ariaLabel={stripAria} />
            </span>
          )}
        </div>
      </div>
      {!compact && onUntrack && (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          data-slot="tracked-row-untrack"
          aria-label={untrackAria}
          className="relative z-10 shrink-0 pointer-coarse:size-11"
          onClick={(event) => {
            event.stopPropagation();
            onUntrack(model);
          }}
        >
          <X aria-hidden="true" />
        </Button>
      )}
      <DrillableRowChevron />
    </li>
  );
}

/** The digest's variant of the row: the same anatomy without the strip or the untrack control. */
export function CompactTrackedRow({ model }: { model: TrackedRowModel }) {
  return <TrackedRow model={model} compact />;
}
