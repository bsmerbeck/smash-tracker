import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type { ScoutCommonOpponent } from '@smash-tracker/shared';

/** Opponents the scouted player has faced most often in the sampled sets. */
export function ScoutCommonOpponentsCard({ opponents }: { opponents: ScoutCommonOpponent[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Common Opponents</CardTitle>
        <CardDescription>Who they run into most, in the sampled sets.</CardDescription>
      </CardHeader>
      <CardContent>
        {opponents.length === 0 ? (
          <p className="text-sm text-muted-foreground">No repeat opponents in the sample.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {opponents.map((opponent) => (
              <li key={opponent.gamerTag} className="flex items-center justify-between gap-2">
                <span className="text-sm">{opponent.gamerTag}</span>
                <span className="shrink-0 whitespace-nowrap text-sm text-muted-foreground">
                  {opponent.sets} set{opponent.sets === 1 ? '' : 's'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
