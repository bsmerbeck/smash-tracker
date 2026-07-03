import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import type { Match } from '@smash-tracker/shared';
import { getFighterById } from '@/data/sprites';
import { stagesById } from '@/data/stages';

/**
 * Recent encounters vs this opponent, newest first (matches `profile.recent`
 * ordering from `getOpponentProfile`): date, your fighter, their fighter,
 * stage, result badge, and the event/tournament name when present (imported
 * start.gg matches).
 */
export function RecentEncounters({ matches }: { matches: Match[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Recent Encounters</CardTitle>
      </CardHeader>
      <CardContent>
        {matches.length === 0 ? (
          <p className="text-sm text-muted-foreground">No encounters recorded yet.</p>
        ) : (
          <ul className="flex flex-col gap-2" aria-label="Recent encounters">
            {matches.map((match) => {
              const fighterSprite = getFighterById(match.fighter_id);
              const opponentSprite = getFighterById(match.opponent_id);
              const stageName =
                match.map && match.map.id !== 0
                  ? (stagesById.get(match.map.id)?.name ?? match.map.name)
                  : 'unknown';
              const eventLabel = match.tournamentName ?? match.eventName;

              return (
                <li
                  key={match.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-2"
                >
                  <div className="flex items-center gap-3">
                    <span className="text-sm text-muted-foreground">
                      {new Date(match.time).toLocaleDateString()}
                    </span>
                    <div className="flex items-center gap-1">
                      {fighterSprite && (
                        <img
                          src={fighterSprite.url}
                          alt={fighterSprite.name}
                          className="size-6 object-contain"
                        />
                      )}
                      <span className="text-xs text-muted-foreground">vs</span>
                      {opponentSprite && (
                        <img
                          src={opponentSprite.url}
                          alt={opponentSprite.name}
                          className="size-6 object-contain"
                        />
                      )}
                    </div>
                    <span className="text-sm">{stageName}</span>
                    {eventLabel && (
                      <span className="text-xs text-muted-foreground">{eventLabel}</span>
                    )}
                  </div>
                  <Badge variant={match.win ? 'success' : 'destructive'}>
                    {match.win ? 'Win' : 'Loss'}
                  </Badge>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
