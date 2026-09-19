import { Fragment, useState } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import type { Match } from '@smash-tracker/shared';
import { getFighterById } from '@/data/sprites';
import { localizedFighterName } from '@/lib/fighterNames';
import { stagesById } from '@/data/stages';
import { useSubjectPath } from '@/hooks/useSubjectPath';
import { matchHasAttachedVideo } from '@/components/FilteredMatchList';
import { DrillableRow, DrillableRowChevron } from '@/components/DrillableRow';

/**
 * Recent encounters vs this opponent, newest first (matches `profile.recent`
 * ordering from `getOpponentProfile`): date, your fighter, their fighter,
 * stage, result badge, and the event/tournament name when present (imported
 * start.gg matches).
 *
 * Phase 38-07 (D-08/D-14): a row with an attached VOD is a whole-row link to
 * the subject-aware video route; a row without one is a whole-row toggle
 * that expands inline with the match facts (and a tournament link when the
 * host can resolve one) — the SAME row rule `FilteredMatchList` already
 * uses for its own rows. This card's only host is `OpponentHubPage.tsx`, so
 * `useSubjectPath()` is called directly.
 */
export function RecentEncounters({
  matches,
  tournamentLinkForMatch,
}: {
  matches: Match[];
  /** Host-supplied resolver for a match's tournament, when it belongs to one — omitted entirely when the host can't resolve one. */
  tournamentLinkForMatch?: (match: Match) => { href: string; label: string } | undefined;
}) {
  const { t, i18n } = useTranslation();
  const subjectPath = useSubjectPath();
  const [expandedId, setExpandedId] = useState<string | null>(null);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('opponents.encounters.title')}</CardTitle>
      </CardHeader>
      <CardContent>
        {matches.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('opponents.encounters.empty')}</p>
        ) : (
          <ul className="flex flex-col gap-2" aria-label={t('opponents.encounters.aria')}>
            {matches.map((match) => {
              const fighterSprite = getFighterById(match.fighter_id);
              const opponentSprite = getFighterById(match.opponent_id);
              const stageName =
                match.map && match.map.id !== 0
                  ? (stagesById.get(match.map.id)?.name ?? match.map.name)
                  : 'unknown';
              const eventLabel = match.tournamentName ?? match.eventName;
              const hasVideo = matchHasAttachedVideo(match);
              const isExpanded = expandedId === match.id;
              const resultText = match.win ? t('common.win') : t('common.loss');
              const dateLabel = new Date(match.time).toLocaleDateString(i18n.language);
              const opponentName = localizedFighterName(match.opponent_id, t);
              const ariaLabel = t('shared.drillableRow.aria', {
                subject: `${dateLabel} — ${opponentName}`,
                context: stageName,
              });
              const tournamentLink = tournamentLinkForMatch?.(match);

              return (
                <Fragment key={match.id}>
                  <li className="relative flex flex-wrap items-center justify-between gap-3 rounded-md border p-2 hover:bg-accent">
                    {hasVideo ? (
                      <DrillableRow
                        as="overlay"
                        to={subjectPath(`/vod?match=${match.id}`)}
                        ariaLabel={ariaLabel}
                      />
                    ) : (
                      <DrillableRow
                        as="overlay"
                        onActivate={() => setExpandedId(isExpanded ? null : match.id)}
                        expanded={isExpanded}
                        ariaLabel={ariaLabel}
                      />
                    )}
                    <div className="flex items-center gap-3">
                      <span className="text-sm text-muted-foreground">{dateLabel}</span>
                      <div className="flex items-center gap-1">
                        {fighterSprite && (
                          <img
                            src={fighterSprite.url}
                            alt={localizedFighterName(fighterSprite.id, t)}
                            className="size-6 object-contain"
                          />
                        )}
                        <span className="text-xs text-muted-foreground">{t('matchups.vs')}</span>
                        {opponentSprite && (
                          <img
                            src={opponentSprite.url}
                            alt={localizedFighterName(opponentSprite.id, t)}
                            className="size-6 object-contain"
                          />
                        )}
                      </div>
                      <span className="text-sm">{stageName}</span>
                      {eventLabel && (
                        <span className="text-xs text-muted-foreground">{eventLabel}</span>
                      )}
                    </div>
                    <span className="flex items-center gap-2">
                      <Badge variant={match.win ? 'success' : 'destructive'}>{resultText}</Badge>
                      <DrillableRowChevron />
                    </span>
                  </li>
                  {isExpanded && !hasVideo && (
                    <li className="flex flex-col gap-1 rounded-md border border-dashed p-2 text-sm text-muted-foreground">
                      <p>
                        {fighterSprite
                          ? localizedFighterName(match.fighter_id, t)
                          : t('common.unknown')}{' '}
                        {t('matchups.vs')}{' '}
                        {opponentSprite
                          ? localizedFighterName(match.opponent_id, t)
                          : t('common.unknown')}
                      </p>
                      <p>{stageName}</p>
                      <p>{new Date(match.time).toLocaleString(i18n.language)}</p>
                      {tournamentLink && (
                        <Link to={tournamentLink.href} className="text-primary hover:underline">
                          {tournamentLink.label}
                        </Link>
                      )}
                    </li>
                  )}
                </Fragment>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
