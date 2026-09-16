import { useTranslation } from 'react-i18next';
import type { Fighter } from '@smash-tracker/shared';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { getFighterById } from '@/data/sprites';
import { useAlphaFighters, useFighterNameResolver } from '@/hooks/useFighterName';
import { useMatchupsContext } from '../MatchupsContext';

/**
 * Ports legacy/src/screens/Matchups/components/SelectOpponent — picks the
 * opposing fighter from the full 85-fighter roster (legacy's SelectOpponent
 * showed every SpriteList entry, not just fighters previously faced).
 *
 * Phase 35 (D-14): splits into a ranked "Faced" group (most-faced first,
 * with a trailing game count) and an alphabetical "Not yet faced" group
 * (the existing `useAlphaFighters` order, no count). Group membership is
 * computed by fighter id via `opponentUsage`, never by display name — the
 * "Faced" group is rendered order, no sorting performed here (that's
 * `usePersistedSelection`'s / `rankOpponentUsage`'s job).
 */
export function SelectOpponent() {
  const { t } = useTranslation();
  const localizedName = useFighterNameResolver();
  const alphaFighters = useAlphaFighters();
  const { opponent, setOpponent, opponentUsage } = useMatchupsContext();

  const facedFighters = opponentUsage
    .map((usage) => ({ sprite: getFighterById(usage.id), games: usage.games }))
    .filter((entry): entry is { sprite: Fighter; games: number } => entry.sprite != null);
  const facedIds = new Set(facedFighters.map((entry) => entry.sprite.id));
  const unfacedFighters = alphaFighters.filter((sprite) => !facedIds.has(sprite.id));

  function selectById(value: string): void {
    const next = getFighterById(Number(value));
    if (next) {
      setOpponent(next);
    }
  }

  return (
    <Select value={opponent ? String(opponent.id) : undefined} onValueChange={selectById}>
      <SelectTrigger aria-label={t('matchups.selectOpponentAria')} className="w-[220px]">
        <SelectValue placeholder={t('matchups.selectPlaceholder')} />
      </SelectTrigger>
      <SelectContent>
        {facedFighters.length > 0 && (
          <SelectGroup>
            <SelectLabel>{t('matchups.selectOpponent.facedGroup')}</SelectLabel>
            {facedFighters.map(({ sprite, games }) => (
              <SelectItem
                key={`faced-${sprite.id}`}
                value={String(sprite.id)}
                trailing={
                  <span className="text-xs text-muted-foreground tabular-nums whitespace-nowrap">
                    {t('shared.pickerUsage.games', { count: games })}
                  </span>
                }
              >
                <img src={sprite.url} alt="" className="size-6 object-contain" />
                {localizedName(sprite.id)}
              </SelectItem>
            ))}
          </SelectGroup>
        )}
        <SelectGroup>
          <SelectLabel>{t('matchups.selectOpponent.unfacedGroup')}</SelectLabel>
          {unfacedFighters.map((sprite) => (
            <SelectItem key={`unfaced-${sprite.id}`} value={String(sprite.id)}>
              <img src={sprite.url} alt="" className="size-6 object-contain" />
              {localizedName(sprite.id)}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}
