import { useTranslation } from 'react-i18next';
import type { Fighter } from '@smash-tracker/shared';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

/** Ports legacy/src/screens/FighterAnalysis/components/SelectFighter. */
export function SelectFighter({
  fighter,
  fighterSprites,
  onChange,
}: {
  fighter: Fighter | undefined;
  fighterSprites: Fighter[];
  onChange: (fighter: Fighter) => void;
}) {
  const { t } = useTranslation();
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
          <SelectItem key={sprite.id} value={String(sprite.id)}>
            <img src={sprite.url} alt="" className="size-6 object-contain" />
            {sprite.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
