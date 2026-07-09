import { useTranslation } from 'react-i18next';
import { SelectGroup, SelectItem, SelectLabel } from '@/components/ui/select';
import { NO_SELECTION_STAGE } from '@/data/stages';
import { StageOption } from '@/components/StageOption';
import type { GroupedStageOptions } from '@/lib/stageOptions';

/**
 * The option list every stage `<Select>` renders (match forms, set wizard,
 * stage breakdown filter): the "no selection" sentinel first, then the
 * user's pinned Favorites, then Most played, then All stages. Groups repeat
 * stages on purpose — see `getGroupedStageOptions`. Must be rendered inside
 * a `<SelectContent>`.
 */
export function StageSelectGroups({ groups }: { groups: GroupedStageOptions }) {
  const { t } = useTranslation();
  const { favorites, mostPlayed, all } = groups;
  return (
    <>
      <SelectItem value={String(NO_SELECTION_STAGE.id)}>{NO_SELECTION_STAGE.name}</SelectItem>
      {favorites.length > 0 && (
        <SelectGroup>
          <SelectLabel>{t('matchForm.favorites')}</SelectLabel>
          {favorites.map((s) => (
            <SelectItem key={`favorite-${s.id}`} value={String(s.id)}>
              <StageOption stage={s} />
            </SelectItem>
          ))}
        </SelectGroup>
      )}
      {mostPlayed.length > 0 && (
        <SelectGroup>
          <SelectLabel>{t('matchForm.mostPlayed')}</SelectLabel>
          {mostPlayed.map((s) => (
            <SelectItem key={`most-played-${s.id}`} value={String(s.id)}>
              <StageOption stage={s} />
            </SelectItem>
          ))}
        </SelectGroup>
      )}
      <SelectGroup>
        <SelectLabel>{t('matchForm.allStages')}</SelectLabel>
        {all.map((s) => (
          <SelectItem key={`all-${s.id}`} value={String(s.id)}>
            <StageOption stage={s} />
          </SelectItem>
        ))}
      </SelectGroup>
    </>
  );
}
