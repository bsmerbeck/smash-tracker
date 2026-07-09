import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
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

function stageLabel(stageId: number, t: TFunction): string {
  return stagesById.get(stageId)?.name ?? t('common.unknown');
}

function tooltipText(game: ClassifiedGame, t: TFunction): string {
  const playedStage =
    game.match.map && game.match.map.id !== 0
      ? stageLabel(game.match.map.id, t)
      : t('tournaments.retro.unknownStage');
  const result = game.match.win ? 'W' : 'L';

  if (game.classification === 'no-data') {
    return t('tournaments.retro.noDataTooltip', { stage: playedStage, result });
  }

  const picks = game.recommendedStageIds.map((id) => stageLabel(id, t)).join('/');
  const advisorText =
    picks.length > 0
      ? t('tournaments.retro.advicePick', { stages: picks })
      : t('tournaments.retro.adviceNone');
  const verdict =
    game.classification === 'followed'
      ? t('tournaments.retro.verdictFollowed')
      : game.classification === 'against'
        ? t('tournaments.retro.verdictAgainst')
        : t('tournaments.retro.verdictNeutral');
  return t('tournaments.retro.advisorTooltip', {
    advice: advisorText,
    stage: playedStage,
    verdict,
    result,
  });
}

function GameIcon({ game }: { game: ClassifiedGame }) {
  const { t } = useTranslation();
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
      <TooltipContent className="max-w-64 text-center">{tooltipText(game, t)}</TooltipContent>
    </Tooltip>
  );
}

function AdherenceSummaryCard({ summary }: { summary: Retrospective['summary'] }) {
  const { t } = useTranslation();
  if (summary.classifiable === 0) {
    return <p className="text-sm text-muted-foreground">{t('tournaments.retro.notEnough')}</p>;
  }

  const parts: string[] = [t('tournaments.retro.adherence', { rate: summary.adherenceRate })];
  const winRateParts: string[] = [];
  if (summary.followedWinRate != null) {
    winRateParts.push(t('tournaments.retro.followedWon', { rate: summary.followedWinRate }));
  }
  if (summary.againstWinRate != null) {
    winRateParts.push(t('tournaments.retro.againstWon', { rate: summary.againstWinRate }));
  }
  if (winRateParts.length > 0) {
    parts.push(winRateParts.join(` ${t('matchups.vs')} `));
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
  const { t } = useTranslation();
  const { rows, otherGames, summary } = retrospective;
  const hasAnyGames = rows.some((r) => r.games.length > 0) || otherGames.length > 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('tournaments.retro.title')}</CardTitle>
        <CardDescription>{t('tournaments.retro.description')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {!hasAnyGames ? (
          <p className="text-sm text-muted-foreground">{t('tournaments.retro.noGames')}</p>
        ) : (
          <>
            <div className="rounded-md border bg-muted/30 p-3">
              <AdherenceSummaryCard summary={summary} />
            </div>

            <ul className="flex flex-col gap-2" aria-label={t('tournaments.retro.setsAria')}>
              {rows.map(({ set, games }) => (
                <li
                  key={set.setId}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3"
                >
                  <span className="min-w-32 text-sm font-medium">
                    {set.roundText ?? t('tournaments.timeline.setFallback', { id: set.setId })}
                  </span>
                  <div className="flex items-center gap-1.5">
                    {games.map((game) => (
                      <GameIcon key={game.match.id} game={game} />
                    ))}
                  </div>
                  <Badge variant={set.won ? 'success' : 'destructive'}>
                    {set.won ? t('tournaments.won') : t('tournaments.lost')}
                  </Badge>
                </li>
              ))}
            </ul>

            {otherGames.length > 0 && (
              <div>
                <h3 className="mb-2 text-sm font-medium text-muted-foreground">
                  {t('tournaments.timeline.otherMatches')}
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
