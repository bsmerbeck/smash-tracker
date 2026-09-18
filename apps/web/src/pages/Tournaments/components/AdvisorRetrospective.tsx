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

/** The localized W/L word for a game's result — reuses the same keys the set-result `Badge` already reads. */
function resultLabel(win: boolean, t: TFunction): string {
  return win ? t('tournaments.won') : t('tournaments.lost');
}

/**
 * ADV-02/D-14's "reason line": what stage was played and how it graded
 * against the advisor's call, ALWAYS visible text (never hover-only).
 * Keyed on `reasonKind` (`lib/retrospective.ts`), not raw `classification`,
 * because the outside-the-ruleset case and the no-data case each need a
 * distinct sentence from the ordinary graded/no-stance cases even though
 * `classification` alone can't tell them apart (a `neutral` no-stance game
 * and a `neutral` outside-the-ruleset game share a classification but never
 * a reason).
 */
function reasonLineText(game: ClassifiedGame, t: TFunction): string {
  const playedStage =
    game.match.map && game.match.map.id !== 0
      ? stageLabel(game.match.map.id, t)
      : t('tournaments.retro.unknownStage');
  const result = resultLabel(game.match.win, t);

  if (game.reasonKind === 'no-data') {
    return t('tournaments.retro.noDataTooltip', { stage: playedStage, result });
  }
  if (game.reasonKind === 'outside-ruleset') {
    // Plan 37-06 Task 2 replaces this literal with the localized
    // `tournaments.retro.reasonOutsideRuleset` key, across all six locales.
    return `${playedStage} — outside this event's ruleset (${result})`;
  }
  const verdict =
    game.classification === 'followed'
      ? t('tournaments.retro.verdictFollowed')
      : game.classification === 'against'
        ? t('tournaments.retro.verdictAgainst')
        : t('tournaments.retro.verdictNeutral');
  // Plan 37-06 Task 2 replaces this literal with the localized
  // `tournaments.retro.reasonLine` key, across all six locales.
  return `${playedStage} — ${verdict} (${result})`;
}

/**
 * ADV-02/D-14's "takeaway line": what the advisor actually recommended for
 * this pairing, ALWAYS visible (never hover-only). Plan 37-06 Task 2
 * replaces this with the six dedicated `tournaments.retro.takeaway.*`
 * strings keyed on (classification, result) — this Task 1 version reuses
 * the existing advice-phrasing keys unedited so no new copy ships ahead of
 * its six-locale translation.
 */
function takeawayLineText(game: ClassifiedGame, t: TFunction): string {
  const picks = game.recommendedStageIds.map((id) => stageLabel(id, t)).join('/');
  // No-data and outside-ruleset both have no recommended stages, so both
  // fall through to `adviceNone` here — deliberately NOT `notEnough` (the
  // summary card's own text), which would collide with it verbatim on the
  // same page for an all-no-data tournament.
  return picks.length > 0
    ? t('tournaments.retro.advicePick', { stages: picks })
    : t('tournaments.retro.adviceNone');
}

/**
 * The classification chip PLUS an always-visible reason line and takeaway
 * line beneath it (ADV-02, D-14) — replaces the pre-Phase-37-06 `GameIcon`,
 * whose classification was legible ONLY inside a hover tooltip (the exact
 * defect ADV-02 forbids). The classification TEXT is what reads; the glyph
 * survives only as decoration beside it. The tooltip stays as a
 * progressive-enhancement extra — never the only access path to any
 * verdict, reason or takeaway, all three of which are ordinary text nodes
 * in the page below.
 */
function GameVerdict({ game }: { game: ClassifiedGame }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-0.5">
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={cn(
              'inline-flex w-fit items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold',
              CLASSIFICATION_STYLE[game.classification],
            )}
          >
            <span aria-hidden="true">{CLASSIFICATION_ICON[game.classification]}</span>
            {/* Plan 37-06 Task 2 replaces this raw enum value with the
                localized `tournaments.retro.chip.*` label. */}
            <span>{game.classification}</span>
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-64 text-center">{tooltipText(game, t)}</TooltipContent>
      </Tooltip>
      <p className="text-xs text-muted-foreground">{reasonLineText(game, t)}</p>
      <p className="text-xs text-muted-foreground">{takeawayLineText(game, t)}</p>
    </div>
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
  const { rows, otherGames, summary, resolvedRuleset } = retrospective;
  const hasAnyGames = rows.some((r) => r.games.length > 0) || otherGames.length > 0;

  const presetName =
    resolvedRuleset.source === 'event-override'
      ? t('shared.ruleset.customName')
      : t('shared.ruleset.preset.default.name');

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('tournaments.retro.title')}</CardTitle>
        <CardDescription className="flex flex-col gap-1">
          {/* Plan 37-06 Task 2 replaces this literal with the localized
              tournaments.retro.rulesetDisclosure key. */}
          <span>Graded under {presetName}</span>
          {/* Plan 37-06 Task 2 replaces this literal with the localized
              tournaments.retro.gradingBasis key. */}
          <span>Every stage this ruleset makes legal was treated as available.</span>
        </CardDescription>
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
                  className="flex flex-wrap items-start justify-between gap-3 rounded-md border p-3"
                >
                  <span className="min-w-32 text-sm font-medium">
                    {set.roundText ?? t('tournaments.timeline.setFallback', { id: set.setId })}
                  </span>
                  <div className="flex flex-wrap items-start gap-3">
                    {games.map((game) => (
                      <GameVerdict key={game.match.id} game={game} />
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
                <div className="flex flex-wrap items-start gap-3">
                  {otherGames.map((game) => (
                    <GameVerdict key={game.match.id} game={game} />
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
