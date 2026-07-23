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

/** Ports legacy/src/screens/Matchups/components/SelectFighter — picks "your" fighter from the user's selections. */
export function SelectFighter() {
  const { t } = useTranslation();
  const localizedName = useFighterNameResolver();
  const { fighter, fighterSprites, setFighter } = useMatchupsContext();

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
      <SelectTrigger aria-label={t('matchups.selectFighterAria')} className="w-[220px]">
        <SelectValue placeholder={t('matchups.selectPlaceholder')} />
      </SelectTrigger>
      <SelectContent>
        {fighterSprites.map((sprite) => (
          <SelectItem key={sprite.id} value={String(sprite.id)}>
            <img src={sprite.url} alt="" className="size-6 object-contain" />
            {localizedName(sprite.id)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
