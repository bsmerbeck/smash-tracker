import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { TournamentEntry } from '@smash-tracker/shared';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useSubjectPath } from '@/hooks/useSubjectPath';
import { DrillableRow, DrillableRowChevron } from '@/components/DrillableRow';
import {
  resolveTournamentEntry,
  tournamentBlockEventKey,
  type TournamentBlock,
  type TournamentSet,
} from '../tournamentHistory';

function formatDate(time: number, locale: string): string {
  return new Date(time).toLocaleDateString(locale, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function formatDateRange(startTime: number, endTime: number, locale: string): string {
  const start = formatDate(startTime, locale);
  const end = formatDate(endTime, locale);
  return start === end ? start : `${start} – ${end}`;
}

/**
 * Every game in a set as a small chip: stage abbreviation, win/loss tint,
 * and a tooltip (native `title`) with the full stage name + date + result.
 */
function GameChips({ games }: { games: TournamentSet['games'] }) {
  const { t, i18n } = useTranslation();
  return (
    <div className="flex flex-wrap gap-1" aria-label={t('opponents.history.gamesAria')}>
      {games.map((game) => (
        <span
          key={game.match.id}
          title={`${game.stageName} — ${game.win ? t('common.win') : t('common.loss')} — ${new Date(
            game.match.time,
          ).toLocaleDateString(i18n.language)}`}
          className={`inline-flex size-7 items-center justify-center rounded text-[10px] font-semibold ${
            game.win
              ? 'bg-emerald-600/15 text-emerald-700 dark:text-emerald-400'
              : 'bg-destructive/15 text-destructive'
          }`}
        >
          {game.stageAbbr}
        </span>
      ))}
    </div>
  );
}

/**
 * Phase 38-07 (D-12/D-14): a set row opens the filtered match list for that
 * set's event — the SAME event-anchor key the hub's own trend-point clicks
 * write — via a host-supplied `onSelectEvent` callback (the host owns the
 * URL and the terminus scroll, matching `handleSelectTrendPoint`'s existing
 * shape). Never a `Link`: this is an in-page action on the SAME page, not a
 * navigation to a different route.
 */
function SetRow({
  set,
  block,
  onSelectEvent,
}: {
  set: TournamentSet;
  block: TournamentBlock;
  onSelectEvent?: (eventKey: string) => void;
}) {
  const { t } = useTranslation();
  const destination = onSelectEvent
    ? () => onSelectEvent(tournamentBlockEventKey(block))
    : undefined;

  const content = (
    <>
      <div className="flex items-center gap-3">
        <span className="w-36 shrink-0 text-sm font-medium">
          {set.roundLabel}
          {set.isLosersSide && (
            <Badge variant="destructive" className="ml-2 align-middle">
              {t('opponents.history.losers')}
            </Badge>
          )}
        </span>
        <GameChips games={set.games} />
      </div>
      <span className="text-sm font-semibold">
        {set.wins}-{set.losses}
      </span>
    </>
  );

  if (destination == null) {
    return (
      <li
        className={`flex flex-wrap items-center justify-between gap-3 rounded-md border p-2 ${
          set.isLosersSide ? 'border-destructive/40 bg-destructive/5' : ''
        }`}
      >
        {content}
      </li>
    );
  }

  return (
    <li
      className={`relative flex flex-wrap items-center justify-between gap-3 rounded-md border p-2 hover:bg-accent ${
        set.isLosersSide ? 'border-destructive/40 bg-destructive/5' : ''
      }`}
    >
      <DrillableRow
        as="overlay"
        onActivate={destination}
        ariaLabel={t('shared.drillableRow.aria', {
          subject: set.roundLabel,
          context: block.displayName,
        })}
      />
      {content}
      <DrillableRowChevron />
    </li>
  );
}

function TournamentBlockCard({
  block,
  registryEntry,
  onSelectEvent,
}: {
  block: TournamentBlock;
  registryEntry: TournamentEntry | null;
  onSelectEvent?: (eventKey: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const subjectPath = useSubjectPath();
  const title = block.displayName;
  // Route on the source-agnostic `entryKey` (always stamped by
  // GET /api/tournaments from the RTDB child key — review WR-04): parry.gg
  // entries have NO numeric eventId, so linking via eventId rendered a dead
  // `/tournaments/undefined` for them. Falls back to eventId only for a
  // legacy start.gg entry shape that somehow lacks entryKey (its child key
  // IS String(eventId)), and renders a plain title when neither exists.
  const entryPath =
    registryEntry?.entryKey ??
    (registryEntry?.eventId != null ? String(registryEntry.eventId) : null);
  return (
    <div className="rounded-lg border">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b p-3">
        <div>
          {entryPath ? (
            <Link
              to={subjectPath(`/tournaments/${entryPath}`)}
              className="font-semibold text-primary underline-offset-2 hover:underline"
            >
              {title}
            </Link>
          ) : (
            <span className="font-semibold">{title}</span>
          )}
          <p className="text-xs text-muted-foreground">
            {formatDateRange(block.startTime, block.endTime, i18n.language)}
          </p>
        </div>
        <span className="text-sm font-semibold">
          {t('opponents.history.vsThemHere', { wins: block.wins, losses: block.losses })}
        </span>
      </div>
      <ul
        className="flex flex-col gap-2 p-3"
        aria-label={t('opponents.history.setsAria', { title })}
      >
        {block.sets.map((set) => (
          <SetRow key={set.setId} set={set} block={block} onSelectEvent={onSelectEvent} />
        ))}
      </ul>
    </div>
  );
}

/**
 * Phase D (docs/analytics-vision.md): tournament history block for the
 * scouting report — every start.gg-imported set played against this
 * opponent, grouped by tournament, with per-set score and per-game stage
 * chips. Grouping/scoring/resolution logic lives in `../tournamentHistory`
 * (pure, unit-tested); this component only renders the resulting structures.
 *
 * Phase 38-07 (D-12/D-14): the block header link now routes through the
 * subject-aware path builder (single host, `OpponentHubPage.tsx`, so this
 * component calls `useSubjectPath()` directly). A set row is drillable when
 * the host supplies `onSelectEvent`; absent it, a row stays plain (matching
 * `OpponentsPage.tsx`'s still-live inline profile panel, which supplies
 * nothing).
 */
export function TournamentHistory({
  blocks,
  tournamentEntries,
  onSelectEvent,
}: {
  blocks: TournamentBlock[];
  tournamentEntries: TournamentEntry[];
  /** Host-supplied: writes the SAME event-anchor axis the hub's trend clicks write, when a set row is activated. */
  onSelectEvent?: (eventKey: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('opponents.history.title')}</CardTitle>
      </CardHeader>
      <CardContent>
        {blocks.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('opponents.history.empty')}</p>
        ) : (
          <div className="flex flex-col gap-4">
            {blocks.map((block) => (
              <TournamentBlockCard
                key={`${block.displayName}-${block.startTime}`}
                block={block}
                registryEntry={resolveTournamentEntry(block, tournamentEntries)}
                onSelectEvent={onSelectEvent}
              />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
