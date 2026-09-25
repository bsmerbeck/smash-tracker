import { useTranslation } from 'react-i18next';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useFighterNameResolver } from '@/hooks/useFighterName';
import { useMatchupsContext } from '../MatchupsContext';

/**
 * Ports legacy/src/screens/Matchups/components/SelectFighter — picks "your"
 * fighter from the user's selections. Phase 35 (D-13): `fighterSprites`
 * arrives PRE-ORDERED by usage from the context (most-to-least games,
 * most-recent tiebreak) — this component performs no sorting of its own,
 * and renders each row with a localized trailing game count.
 */
/**
 * WR-07 (39.1-REVIEW.md): `id` goes on the trigger so a visible
 * `<label htmlFor={id}>` names it; with an `id` the trigger carries no
 * `aria-label` (which would override the visible label). Without one — a
 * standalone render — the descriptive `matchups.selectFighterAria` name remains.
 */
export function SelectFighter({ id }: { id?: string } = {}) {
  const { t } = useTranslation();
  const localizedName = useFighterNameResolver();
  const { fighter, fighterSprites, setFighter, fighterUsageById } = useMatchupsContext();

  return (
    <Select
      value={fighter ? String(fighter.id) : undefined}
      onValueChange={(value) => {
        const next = fighterSprites.find((s) => String(s.id) === value);
        if (next) {
          setFighter(next);
        }
      }}
    >
      <SelectTrigger
        {...(id ? { id } : { 'aria-label': t('matchups.selectFighterAria') })}
        className="w-full"
      >
        <SelectValue placeholder={t('matchups.selectPlaceholder')} />
      </SelectTrigger>
      <SelectContent>
        {fighterSprites.map((sprite) => (
          <SelectItem
            key={sprite.id}
            value={String(sprite.id)}
            trailing={
              <span className="text-xs text-muted-foreground tabular-nums whitespace-nowrap">
                {t('shared.pickerUsage.games', { count: fighterUsageById.get(sprite.id) ?? 0 })}
              </span>
            }
          >
            <img src={sprite.url} alt="" className="size-6 object-contain" />
            {localizedName(sprite.id)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
