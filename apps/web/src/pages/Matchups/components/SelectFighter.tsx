import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useMatchupsContext } from '../MatchupsContext';

/** Ports legacy/src/screens/Matchups/components/SelectFighter — picks "your" fighter from the user's selections. */
export function SelectFighter() {
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
      <SelectTrigger aria-label="Select your fighter" className="w-[220px]">
        <SelectValue placeholder="Select a fighter" />
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
