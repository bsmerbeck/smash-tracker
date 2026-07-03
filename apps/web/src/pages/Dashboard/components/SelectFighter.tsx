import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useDashboardContext } from '../DashboardContext';

/** Ports legacy/src/screens/Dashboard/components/DashboardToolbar/components/SelectFighter. */
export function SelectFighter() {
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
      <SelectTrigger aria-label="Select fighter" className="w-[220px]">
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
