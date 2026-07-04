import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { stagesById } from '@/data/stages';
import { cn } from '@/lib/utils';
import type { ClassifiedGame, Retrospective } from '../lib/retrospective';

const CLASSIFICATION_ICON: Record<ClassifiedGame['classification'], string> = {
  followed: '✓',
  against: '✗',
  neutral: '•',
  'no-data': '?',
};

const CLASSIFICATION_STYLE: Record<ClassifiedGame['classification'], string> = {
  followed: 'bg-emerald-600 text-white',
  against: 'bg-destructive text-white',
  neutral: 'bg-muted text-muted-foreground',
  'no-data': 'border border-dashed text-muted-foreground',
};

function stageLabel(stageId: number): string {
  return stagesById.get(stageId)?.name ?? 'Unknown';
}

function tooltipText(game: ClassifiedGame): string {
  const playedStage =
    game.match.map && game.match.map.id !== 0 ? stageLabel(game.match.map.id) : 'unknown stage';
  const result = game.match.win ? 'W' : 'L';

  if (game.classification === 'no-data') {
    return `Not enough pre-tournament data to grade this pick. You played ${playedStage}. Result: ${result}`;
  }

  const picks = game.recommendedStageIds.map(stageLabel).join('/');
  const advisorText = picks.length > 0 ? `pick ${picks}` : 'no clear pick';
  const verdict =
    game.classification === 'followed'
      ? 'followed'
      : game.classification === 'against'
        ? 'against'
        : 'neutral on';
  return `Advisor would have said: ${advisorText} — you played ${playedStage} (${verdict}). Result: ${result}`;
}

function GameIcon({ game }: { game: ClassifiedGame }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            'flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold',
            CLASSIFICATION_STYLE[game.classification],
          )}
          aria-label={game.classification}
        >
          {CLASSIFICATION_ICON[game.classification]}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-64 text-center">{tooltipText(game)}</TooltipContent>
    </Tooltip>
  );
}

function AdherenceSummaryCard({ summary }: { summary: Retrospective['summary'] }) {
  if (summary.classifiable === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Not enough pre-tournament data to grade these picks.
      </p>
    );
  }

  const parts: string[] = [`Advisor adherence: ${summary.adherenceRate}% of classifiable picks`];
  const winRateParts: string[] = [];
  if (summary.followedWinRate != null) {
    winRateParts.push(`followed picks won ${summary.followedWinRate}%`);
  }
  if (summary.againstWinRate != null) {
    winRateParts.push(`${summary.againstWinRate}% when against`);
  }
  if (winRateParts.length > 0) {
    parts.push(winRateParts.join(' vs '));
  }

  return <p className="text-sm">{parts.join(' · ')}</p>;
}

/**
 * The marquee retrospective: grades each classifiable game in the
 * tournament against what the Counterpick Advisor would have said using
 * only pre-tournament evidence for that pairing. Purely a renderer over
 * `buildRetrospective`'s output — all the classification/adherence math
 * lives in `lib/retrospective.ts`.
 */
export function AdvisorRetrospective({ retrospective }: { retrospective: Retrospective }) {
  const { rows, otherGames, summary } = retrospective;
  const hasAnyGames = rows.some((r) => r.games.length > 0) || otherGames.length > 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Advisor Retrospective</CardTitle>
        <CardDescription>
          Grading each pick against what the Counterpick Advisor would have recommended, using only
          data from before this tournament started.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {!hasAnyGames ? (
          <p className="text-sm text-muted-foreground">No games recorded for this event yet.</p>
        ) : (
          <>
            <div className="rounded-md border bg-muted/30 p-3">
              <AdherenceSummaryCard summary={summary} />
            </div>

            <ul className="flex flex-col gap-2" aria-label="Advisor retrospective sets">
              {rows.map(({ set, games }) => (
                <li
                  key={set.setId}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3"
                >
                  <span className="min-w-32 text-sm font-medium">
                    {set.roundText ?? `Set ${set.setId}`}
                  </span>
                  <div className="flex items-center gap-1.5">
                    {games.map((game) => (
                      <GameIcon key={game.match.id} game={game} />
                    ))}
                  </div>
                  <Badge variant={set.won ? 'success' : 'destructive'}>
                    {set.won ? 'Won' : 'Lost'}
                  </Badge>
                </li>
              ))}
            </ul>

            {otherGames.length > 0 && (
              <div>
                <h3 className="mb-2 text-sm font-medium text-muted-foreground">
                  Other matches during this event
                </h3>
                <div className="flex flex-wrap items-center gap-1.5">
                  {otherGames.map((game) => (
                    <GameIcon key={game.match.id} game={game} />
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
