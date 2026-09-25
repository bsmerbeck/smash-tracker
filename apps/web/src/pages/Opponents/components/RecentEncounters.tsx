import { Fragment, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { Video } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { UNKNOWN_STAGE_ID } from '@smash-tracker/shared';
import type { Match } from '@smash-tracker/shared';
import { localizedFighterName } from '@/lib/fighterNames';
import { stagesById } from '@/data/stages';
import { stageAbbreviation } from '@/components/StageOption';
import { useSubjectPath } from '@/hooks/useSubjectPath';
import { matchHasAttachedVideo } from '@/components/FilteredMatchList';
import { DrillableRow, DrillableRowChevron } from '@/components/DrillableRow';
import { CHART_TOKENS } from '@/components/charts/tokens';
import { LIST_CAP, LIST_INLINE_MAX } from '@/components/analytics/BoundedList';
import { groupEncounters, type EncounterGroup, type EncounterSet } from './encounterGrouping';

/**
 * Phase 39.1 Plan 18 (UIX-08/D-10, UI-SPEC §8.6): owner note 10 ("could
 * click and go to the match, see a set from the matches") — games become
 * SETS under EVENT headers, newest first, each set a real expandable row
 * through Phase 38's inline-expansion contract one level up (a set row
 * expands to its games; each revealed game then follows Phase 38's own D-08
 * video/inline-facts rule). Manual games with no parseable set identifier
 * stay single rows under a session header. Capped at `LIST_CAP` (8) sets
 * with a show-all control that expands inline for up to `LIST_INLINE_MAX`
 * (25) sets and, past that, hands off directly to the hub's filtered match
 * list rather than a 25-row inline state — see this file's own doc comment
 * on `RecentEncounters` for why (this plan's `<verification>` forbids
 * editing a locale file, and no third-rung "terminus" string is
 * pre-provisioned).
 *
 * Locale keys: `analytics.encounters.sessionHeader`/`setAria`/`showAll` were
 * landed unused by an earlier plan's i18n vocabulary pass specifically for
 * this component — reused here rather than adding any new key.
 *
 * This card's only host is `OpponentHubPage.tsx`, so `useSubjectPath()` is
 * called directly, as before.
 */

/** Runs at most `limit` sets total, keeping a group only when it has at least one visible set — never a partial header with zero visible sets. */
function takeSets(groups: EncounterGroup[], limit: number): EncounterGroup[] {
  let remaining = limit;
  const result: EncounterGroup[] = [];
  for (const group of groups) {
    if (remaining <= 0) break;
    const takenSets = group.sets.slice(0, remaining);
    if (takenSets.length > 0) {
      result.push({ ...group, sets: takenSets });
      remaining -= takenSets.length;
    }
  }
  return result;
}

function countSets(groups: EncounterGroup[]): number {
  return groups.reduce((sum, group) => sum + group.sets.length, 0);
}

function sessionRecord(group: EncounterGroup): string {
  const wins = group.sets.reduce((sum, set) => sum + set.gamesWon, 0);
  const losses = group.sets.reduce((sum, set) => sum + set.gamesLost, 0);
  return `${wins}–${losses}`;
}

function GroupHeader({
  group,
  tournamentLinkForMatch,
  t,
  i18n,
}: {
  group: EncounterGroup;
  tournamentLinkForMatch?: (match: Match) => { href: string; label: string } | undefined;
  t: TFunction;
  i18n: { language: string };
}) {
  const dateLabel = new Date(group.dateMs).toLocaleDateString(i18n.language);

  if (group.kind === 'session') {
    return (
      <div
        className="flex items-center justify-between gap-2 px-1 text-sm font-medium text-muted-foreground"
        data-slot="encounter-session-header"
      >
        <span>
          {t('analytics.encounters.sessionHeader', {
            date: dateLabel,
            record: sessionRecord(group),
          })}
        </span>
      </div>
    );
  }

  const firstMatch = group.sets[0]?.games[0]?.match;
  const link = firstMatch ? tournamentLinkForMatch?.(firstMatch) : undefined;
  const content = (
    <>
      <span className="min-w-0 flex-1 truncate" title={group.label} data-truncate-guard>
        {group.label}
      </span>
      <span className="shrink-0 text-xs text-muted-foreground">{dateLabel}</span>
    </>
  );

  if (link) {
    return (
      <Link
        to={link.href}
        className="flex items-center justify-between gap-2 px-1 text-sm font-medium hover:underline"
        data-slot="encounter-event-header"
      >
        {content}
      </Link>
    );
  }
  return (
    <div
      className="flex items-center justify-between gap-2 px-1 text-sm font-medium"
      data-slot="encounter-event-header"
    >
      {content}
    </div>
  );
}

function stageLabelFor(stageId: number, t: TFunction): string {
  if (stageId === UNKNOWN_STAGE_ID) {
    return t('common.unknown');
  }
  const name = stagesById.get(stageId)?.name;
  return name ? stageAbbreviation(name) : t('common.unknown');
}

function SetRow({
  set,
  indexInGroup,
  isExpanded,
  onToggle,
  t,
}: {
  set: EncounterSet;
  indexInGroup: number;
  isExpanded: boolean;
  onToggle: () => void;
  t: TFunction;
}) {
  const singleGame = set.games.length === 1;
  const resultWord = set.won ? t('common.win') : t('common.loss');
  const scoreText = singleGame ? resultWord : `${resultWord} ${set.gamesWon}–${set.gamesLost}`;

  const userFighterId = set.userFighterIds[0];
  const opponentFighterId = set.opponentFighterIds[0];
  const userName =
    userFighterId != null ? localizedFighterName(userFighterId, t) : t('common.unknown');
  const opponentName =
    opponentFighterId != null ? localizedFighterName(opponentFighterId, t) : t('common.unknown');
  const fightersPhrase = `${userName} ${t('matchups.vs')} ${opponentName} ×${set.games.length}`;

  const stageText = set.stageIds.map((id) => stageLabelFor(id, t)).join(' · ');
  const hasVideo = set.games.some((game) => matchHasAttachedVideo(game.match));

  const ariaLabel = t('analytics.encounters.setAria', { index: indexInGroup, record: scoreText });

  return (
    <li
      className="relative flex flex-wrap items-center gap-2 rounded-md border p-2 hover:bg-accent"
      data-slot="encounter-set-row"
    >
      <DrillableRow
        as="overlay"
        onActivate={onToggle}
        expanded={isExpanded}
        ariaLabel={ariaLabel}
      />
      <span className="flex shrink-0 items-center gap-1.5">
        <span
          aria-hidden="true"
          data-slot={set.won ? 'encounter-set-status-win' : 'encounter-set-status-loss'}
          className="inline-block size-1.5 rounded-sm"
          style={{ backgroundColor: set.won ? CHART_TOKENS.win : CHART_TOKENS.loss }}
        />
        <span className="text-sm tabular-nums">{scoreText}</span>
      </span>
      <span className="min-w-0 flex-1 truncate" title={fightersPhrase} data-truncate-guard>
        {fightersPhrase}
      </span>
      <span className="shrink-0 text-xs text-muted-foreground">{stageText}</span>
      {hasVideo && <Video className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />}
      <DrillableRowChevron />
    </li>
  );
}

function ExpandedGames({
  set,
  subjectPath,
  t,
  i18n,
}: {
  set: EncounterSet;
  subjectPath: (personalPath: string) => string;
  t: TFunction;
  i18n: { language: string };
}) {
  return (
    <li className="flex flex-col gap-1 rounded-md border border-dashed p-2 text-sm text-muted-foreground">
      {set.games.map((game) => {
        const match = game.match;
        const label = `${match.win ? t('common.win') : t('common.loss')} · ${new Date(match.time).toLocaleDateString(i18n.language)}`;
        return (
          <p key={match.id}>
            {matchHasAttachedVideo(match) ? (
              <Link
                to={subjectPath(`/vod?match=${match.id}`)}
                className="text-primary hover:underline"
              >
                {label}
              </Link>
            ) : (
              label
            )}
          </p>
        );
      })}
    </li>
  );
}

export function RecentEncounters({
  matches,
  tournamentLinkForMatch,
  onSeeAllInMatchList,
}: {
  matches: Match[];
  /** Host-supplied resolver for a match's tournament, when it belongs to one — omitted entirely when the host can't resolve one. */
  tournamentLinkForMatch?: (match: Match) => { href: string; label: string } | undefined;
  /** Called when the reader chooses to see more than `LIST_INLINE_MAX` sets — the host's own hub filtered-match-list anchor. */
  onSeeAllInMatchList?: () => void;
}) {
  const { t, i18n } = useTranslation();
  const subjectPath = useSubjectPath();
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [showAllExpanded, setShowAllExpanded] = useState(false);

  const groups = useMemo(() => groupEncounters({ matches }), [matches]);
  const totalSets = useMemo(() => countSets(groups), [groups]);
  const hasMore = totalSets > LIST_CAP;
  const fitsInline = totalSets <= LIST_INLINE_MAX;
  const visibleLimit = showAllExpanded
    ? Math.min(totalSets, LIST_INLINE_MAX)
    : Math.min(totalSets, LIST_CAP);
  const visibleGroups = useMemo(() => takeSets(groups, visibleLimit), [groups, visibleLimit]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('opponents.encounters.title')}</CardTitle>
      </CardHeader>
      <CardContent>
        {matches.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('opponents.encounters.empty')}</p>
        ) : (
          <div className="flex flex-col gap-4" aria-label={t('opponents.encounters.aria')}>
            {visibleGroups.map((group) => (
              <div key={group.key} className="flex flex-col gap-2" data-slot="encounter-group">
                <GroupHeader
                  group={group}
                  tournamentLinkForMatch={tournamentLinkForMatch}
                  t={t}
                  i18n={i18n}
                />
                <ul className="flex flex-col gap-2">
                  {group.sets.map((set, index) => {
                    const fullKey = `${group.key}::${set.key}`;
                    const isExpanded = expandedKey === fullKey;
                    return (
                      <Fragment key={set.key}>
                        <SetRow
                          set={set}
                          indexInGroup={index + 1}
                          isExpanded={isExpanded}
                          onToggle={() => setExpandedKey(isExpanded ? null : fullKey)}
                          t={t}
                        />
                        {isExpanded && (
                          <ExpandedGames set={set} subjectPath={subjectPath} t={t} i18n={i18n} />
                        )}
                      </Fragment>
                    );
                  })}
                </ul>
              </div>
            ))}

            {hasMore && !showAllExpanded && (
              <Button
                type="button"
                variant="link"
                size="sm"
                onClick={() => {
                  if (fitsInline) {
                    setShowAllExpanded(true);
                  } else {
                    onSeeAllInMatchList?.();
                  }
                }}
              >
                {t('analytics.encounters.showAll')}
              </Button>
            )}
            {showAllExpanded && (
              <Button
                type="button"
                variant="link"
                size="sm"
                onClick={() => setShowAllExpanded(false)}
              >
                {t('analytics.list.showFewer')}
              </Button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
