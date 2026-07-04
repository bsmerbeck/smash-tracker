import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type { ScoutStageUsage } from '@smash-tracker/shared';
import { stagesById } from '@/data/stages';

const MAX_STAGES = 6;

/** The scouted player's stage results (art tile + record + win rate), most-played first. */
export function ScoutStagesCard({ stages }: { stages: ScoutStageUsage[] }) {
  const top = stages.filter((s) => s.stageId !== 0).slice(0, MAX_STAGES);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Stage Performance</CardTitle>
        <CardDescription>Their results by stage.</CardDescription>
      </CardHeader>
      <CardContent>
        {top.length === 0 ? (
          <p className="text-sm text-muted-foreground">No stage data recorded yet.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {top.map((row) => {
              const stage = stagesById.get(row.stageId);
              const winRate = Math.round((row.wins / row.games) * 100);
              return (
                <li key={row.stageId} className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    {stage?.url ? (
                      <img src={stage.url} alt="" className="h-8 w-14 rounded object-cover" />
                    ) : (
                      <span className="flex h-8 w-14 items-center justify-center rounded bg-muted text-[10px] font-semibold text-muted-foreground">
                        {stage ? stage.name.slice(0, 3).toUpperCase() : '??'}
                      </span>
                    )}
                    <span className="text-sm">{stage?.name ?? 'Unknown'}</span>
                  </div>
                  <span className="shrink-0 whitespace-nowrap text-sm text-muted-foreground">
                    {row.wins}-{row.games - row.wins} · {winRate}% · {row.games} game
                    {row.games === 1 ? '' : 's'}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
