import { useTranslation } from 'react-i18next';
import type { Fighter } from '@smash-tracker/shared';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useFighterNameResolver } from '@/hooks/useFighterName';

/**
 * Ports legacy/src/screens/FighterAnalysis/components/SelectFighter. Phase
 * 35-03 (D-13): `fighterSprites` arrives PRE-ORDERED by usage from
 * `usePersistedSelection` (most-to-least games, most-recent tiebreak) — this
 * component performs no sorting of its own, and renders each row with the
 * same localized trailing game count the Matchups picker shows.
 */
export function SelectFighter({
  fighter,
  fighterSprites,
  fighterUsageById,
  onChange,
}: {
  fighter: Fighter | undefined;
  fighterSprites: Fighter[];
  fighterUsageById: Map<number, number>;
  onChange: (fighter: Fighter) => void;
}) {
  const { t } = useTranslation();
  const localizedName = useFighterNameResolver();
  return (
    <Select
      value={fighter ? String(fighter.id) : undefined}
      onValueChange={(value) => {
        const next = fighterSprites.find((s) => String(s.id) === value);
        if (next) {
          onChange(next);
        }
      }}
    >
      <SelectTrigger aria-label={t('fighterAnalysis.selectAria')} className="w-[220px]">
        <SelectValue placeholder={t('fighterAnalysis.selectPlaceholder')} />
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
