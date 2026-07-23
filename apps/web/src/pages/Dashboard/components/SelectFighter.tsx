import { useTranslation } from 'react-i18next';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useFighterNameResolver } from '@/hooks/useFighterName';
import { useDashboardContext } from '../DashboardContext';

/** Ports legacy/src/screens/Dashboard/components/DashboardToolbar/components/SelectFighter. */
export function SelectFighter() {
  const { t } = useTranslation();
  const localizedName = useFighterNameResolver();
  const { fighter, fighterSprites, setFighter } = useDashboardContext();

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
      <SelectTrigger aria-label={t('dashboard.selectFighter.aria')} className="w-[220px]">
        <SelectValue placeholder={t('dashboard.selectFighter.placeholder')} />
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
