import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { stagesById } from '@/data/stages';
import { cn } from '@/lib/utils';
import { useSubjectPath } from '@/hooks/useSubjectPath';
import { buildDrillDownSearch } from '@/lib/drillDownParams';
import { DrillableRow } from '@/components/DrillableRow';
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

/** ADV-02/D-14: the chip's visible label key, one per classification value — the TEXT that reads, not the glyph. */
const CHIP_LABEL_KEY: Record<ClassifiedGame['classification'], string> = {
  followed: 'tournaments.retro.chip.followed',
  against: 'tournaments.retro.chip.against',
  neutral: 'tournaments.retro.chip.neutral',
  'no-data': 'tournaments.retro.chip.noData',
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

/** The localized "Won"/"Lost" word for a game's result — reuses the same keys the set-result `Badge` already reads. */
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
    return t('tournaments.retro.reasonOutsideRuleset', { stage: playedStage, result });
  }
  const verdict =
    game.classification === 'followed'
      ? t('tournaments.retro.verdictFollowed')
      : game.classification === 'against'
        ? t('tournaments.retro.verdictAgainst')
        : t('tournaments.retro.verdictNeutral');
  return t('tournaments.retro.reasonLine', { stage: playedStage, verdict, result });
}

/**
 * ADV-02/D-14's "takeaway line" key: a closed lookup on (classification,
 * result) — never a chain of conditionals producing a string, and never a
 * string assembled from fragments (the D-12 non-causal requirement is
 * authored ONCE per key, not re-derived per render). No-data and the two
 * no-stance causes (ordinary and outside-the-ruleset) both read the SAME
 * takeaway — only the reason line above distinguishes the outside-the-
 * ruleset case; the takeaway is about the recommendation, which is equally
 * absent/uninformative in both no-stance causes.
 */
function takeawayKey(game: ClassifiedGame): string {
  if (game.reasonKind === 'no-data') {
    return 'tournaments.retro.takeaway.noData';
  }
  switch (game.classification) {
    case 'followed':
      return game.match.win
        ? 'tournaments.retro.takeaway.followedWin'
        : 'tournaments.retro.takeaway.followedLoss';
    case 'against':
      return game.match.win
        ? 'tournaments.retro.takeaway.againstWin'
        : 'tournaments.retro.takeaway.againstLoss';
    default:
      return 'tournaments.retro.takeaway.neutral';
  }
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
/** Phase 38-07 (D-14): a pick opens the stage detail page scoped to this event — `undefined` when the played stage is unknown (`map.id` 0/absent), the ONLY permitted exemption for this row. */
function retrospectiveStageHref(
  game: ClassifiedGame,
  eventKey: string | undefined,
  subjectPath: (path: string) => string,
): string | undefined {
  const stageId = game.match.map?.id ?? 0;
  if (stageId === 0) {
    return undefined;
  }
  const search = buildDrillDownSearch(eventKey ? { eventKey } : {}).toString();
  return subjectPath(`/stages/${stageId}${search ? `?${search}` : ''}`);
}

function GameVerdict({
  game,
  destination,
}: {
  game: ClassifiedGame;
  /** Host-supplied destination — `undefined` for the unknown-stage exemption, in which case this renders plain (no chevron, no link). */
  destination?: string;
}) {
  const { t } = useTranslation();
  const content = (
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
            <span>{t(CHIP_LABEL_KEY[game.classification])}</span>
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-64 text-center">{tooltipText(game, t)}</TooltipContent>
      </Tooltip>
      <p className="text-xs text-muted-foreground">{reasonLineText(game, t)}</p>
      <p className="text-xs text-muted-foreground">{t(takeawayKey(game))}</p>
    </div>
  );

  if (destination == null) {
    return content;
  }

  return (
    <DrillableRow
      to={destination}
      ariaLabel={t('shared.drillableRow.aria', {
        subject: t(CHIP_LABEL_KEY[game.classification]),
        context: reasonLineText(game, t),
      })}
      className="items-start"
    >
      {content}
    </DrillableRow>
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
export function AdvisorRetrospective({
  retrospective,
  eventKey,
}: {
  retrospective: Retrospective;
  /** The host tournament entry's key (D-14) — threaded down rather than derived here, since a pick has no event key of its own. */
  eventKey?: string;
}) {
  const { t } = useTranslation();
  const subjectPath = useSubjectPath();
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
          <span>
            {t('tournaments.retro.rulesetDisclosure', {
              preset: presetName,
              source: resolvedRuleset.ruleset.source.url,
            })}
          </span>
          <span>{t('tournaments.retro.gradingBasis')}</span>
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
                      <GameVerdict
                        key={game.match.id}
                        game={game}
                        destination={retrospectiveStageHref(game, eventKey, subjectPath)}
                      />
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
                    <GameVerdict
                      key={game.match.id}
                      game={game}
                      destination={retrospectiveStageHref(game, eventKey, subjectPath)}
                    />
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
