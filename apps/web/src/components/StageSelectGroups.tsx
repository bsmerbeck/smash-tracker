import { useTranslation } from 'react-i18next';
import { Heart } from 'lucide-react';
import type { Stage } from '@smash-tracker/shared';
import { SelectGroup, SelectItem, SelectLabel, SelectValue } from '@/components/ui/select';
import { NO_SELECTION_STAGE } from '@/data/stages';
import { StageOption } from '@/components/StageOption';
import { cn } from '@/lib/utils';
import { stageOptions, type GroupedStageOptions } from '@/lib/stageOptions';

/**
 * Trigger face for a stage `<Select>` — use this instead of a bare
 * `<SelectValue />`. Radix fills an empty `SelectValue` by portaling the
 * selected item's `ItemText` into it, and stage pickers deliberately repeat
 * a stage across groups (Favorites/Most played/All) under the same value —
 * every copy portals, so a favorited selection rendered twice in the
 * trigger. Explicit children opt out of the portal mechanism entirely.
 */
export function StageSelectValue({ stageId }: { stageId: number }) {
  const stage = stageOptions.find((s) => s.id === stageId) ?? NO_SELECTION_STAGE;
  return <SelectValue>{'url' in stage ? <StageOption stage={stage} /> : stage.name}</SelectValue>;
}

/**
 * The option list every stage `<Select>` renders (match forms, set wizard,
 * stage breakdown filter): the "no selection" sentinel first, then the
 * user's pinned Favorites, then Standard (the online trio, where the picker
 * asks for it), then Most played, then All stages. Groups repeat stages on
 * purpose — see `getGroupedStageOptions`. Must be rendered inside a
 * `<SelectContent>`.
 *
 * When `onToggleFavorite` is given, every stage row gets a heart button that
 * favorites/unfavorites it in place — without selecting the row or closing
 * the dropdown — so favorites are manageable right where they're used, not
 * only from Profile > Favorite Stages.
 */
export function StageSelectGroups({
  groups,
  onToggleFavorite,
}: {
  groups: GroupedStageOptions;
  /** Called with the stage id when a row's heart is clicked (typically `useToggleStageFavorite`). Omit to render plain rows with no hearts. */
  onToggleFavorite?: (stageId: number) => void;
}) {
  const { t } = useTranslation();
  const { favorites, standard, mostPlayed, all } = groups;
  const favoriteIds = new Set(favorites.map((s) => s.id));

  const heartFor = (stage: Stage) =>
    onToggleFavorite && (
      <FavoriteToggle
        stage={stage}
        favorited={favoriteIds.has(stage.id)}
        onToggle={onToggleFavorite}
      />
    );

  return (
    <>
      <SelectItem value={String(NO_SELECTION_STAGE.id)}>{NO_SELECTION_STAGE.name}</SelectItem>
      {favorites.length > 0 && (
        <SelectGroup>
          <SelectLabel>{t('matchForm.favorites')}</SelectLabel>
          {favorites.map((s) => (
            <SelectItem key={`favorite-${s.id}`} value={String(s.id)} trailing={heartFor(s)}>
              <StageOption stage={s} />
            </SelectItem>
          ))}
        </SelectGroup>
      )}
      {standard.length > 0 && (
        <SelectGroup>
          <SelectLabel>{t('matchForm.standardStages')}</SelectLabel>
          {standard.map((s) => (
            <SelectItem key={`standard-${s.id}`} value={String(s.id)} trailing={heartFor(s)}>
              <StageOption stage={s} />
            </SelectItem>
          ))}
        </SelectGroup>
      )}
      {mostPlayed.length > 0 && (
        <SelectGroup>
          <SelectLabel>{t('matchForm.mostPlayed')}</SelectLabel>
          {mostPlayed.map((s) => (
            <SelectItem key={`most-played-${s.id}`} value={String(s.id)} trailing={heartFor(s)}>
              <StageOption stage={s} />
            </SelectItem>
          ))}
        </SelectGroup>
      )}
      <SelectGroup>
        <SelectLabel>{t('matchForm.allStages')}</SelectLabel>
        {all.map((s) => (
          <SelectItem key={`all-${s.id}`} value={String(s.id)} trailing={heartFor(s)}>
            <StageOption stage={s} />
          </SelectItem>
        ))}
      </SelectGroup>
    </>
  );
}

function FavoriteToggle({
  stage,
  favorited,
  onToggle,
}: {
  stage: Stage;
  favorited: boolean;
  onToggle: (stageId: number) => void;
}) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      // Not tab-reachable: an open Radix Select traps focus on the listbox
      // and navigates by arrow keys. Keyboard users manage favorites from
      // Profile > Favorite Stages.
      tabIndex={-1}
      aria-label={
        favorited
          ? t('matchForm.removeFavorite', { stage: stage.name })
          : t('matchForm.addFavorite', { stage: stage.name })
      }
      className="flex size-7 items-center justify-center rounded-sm hover:bg-accent"
      // Swallow the whole pointer sequence: any of these reaching the Radix
      // item would select it and close the dropdown.
      onPointerDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onPointerUp={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onToggle(stage.id);
      }}
    >
      <Heart className={cn('size-4', favorited && 'fill-rose-500 text-rose-500')} />
    </button>
  );
}
