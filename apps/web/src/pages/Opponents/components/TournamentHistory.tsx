import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { TournamentEntry } from '@smash-tracker/shared';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  resolveTournamentEntry,
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

function SetRow({ set }: { set: TournamentSet }) {
  const { t } = useTranslation();
  return (
    <li
      className={`flex flex-wrap items-center justify-between gap-3 rounded-md border p-2 ${
        set.isLosersSide ? 'border-destructive/40 bg-destructive/5' : ''
      }`}
    >
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
    </li>
  );
}

function TournamentBlockCard({
  block,
  registryEntry,
}: {
  block: TournamentBlock;
  registryEntry: TournamentEntry | null;
}) {
  const { t, i18n } = useTranslation();
  const title = block.displayName;
  return (
    <div className="rounded-lg border">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b p-3">
        <div>
          {registryEntry ? (
            <Link
              to={`/tournaments/${registryEntry.eventId}`}
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
          <SetRow key={set.setId} set={set} />
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
 */
export function TournamentHistory({
  blocks,
  tournamentEntries,
}: {
  blocks: TournamentBlock[];
  tournamentEntries: TournamentEntry[];
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
              />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
