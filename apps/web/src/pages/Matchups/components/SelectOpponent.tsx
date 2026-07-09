import { useTranslation } from 'react-i18next';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { alphaSpriteList } from '@/components/match-form/MatchForm';
import { useMatchupsContext } from '../MatchupsContext';

/**
 * Ports legacy/src/screens/Matchups/components/SelectOpponent — picks the
 * opposing fighter from the full 85-fighter roster (legacy's SelectOpponent
 * showed every SpriteList entry, not just fighters previously faced).
 */
export function SelectOpponent() {
  const { t } = useTranslation();
  const { opponent, setOpponent } = useMatchupsContext();

  return (
    <Select
      value={opponent ? String(opponent.id) : undefined}
      onValueChange={(value) => {
        const next = alphaSpriteList.find((s) => String(s.id) === value);
        if (next) {
          setOpponent(next);
        }
      }}
    >
      <SelectTrigger aria-label={t('matchups.selectOpponentAria')} className="w-[220px]">
        <SelectValue placeholder={t('matchups.selectPlaceholder')} />
      </SelectTrigger>
      <SelectContent>
        {alphaSpriteList.map((sprite) => (
          <SelectItem key={sprite.id} value={String(sprite.id)}>
            <img src={sprite.url} alt="" className="size-6 object-contain" />
            {sprite.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
