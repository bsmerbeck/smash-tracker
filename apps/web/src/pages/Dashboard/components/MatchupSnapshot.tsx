import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { Match } from '@smash-tracker/shared';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { getFighterById } from '@/data/sprites';
import { localizedFighterName } from '@/lib/fighterNames';
import { filterByFighter, rankMatchupsByEvidence, type RankedMatchup } from '@/lib/stats';
import { useSubjectPath } from '@/hooks/useSubjectPath';
import { useDashboardContext } from '../DashboardContext';

const SNAPSHOT_COUNT = 3;
const TOUGHEST_MIN_GAMES = 3;
const TOUGHEST_MIN_ROWS = 2;

export interface MatchupSnapshotData {
  strongest: RankedMatchup[];
  /** Empty when fewer than `TOUGHEST_MIN_ROWS` matchups meet `TOUGHEST_MIN_GAMES` — not enough evidence to call out a "toughest" matchup yet. */
  toughest: RankedMatchup[];
  /** True when there's ranked data at all, but not enough qualifying rows to show a toughest-matchups list. */
  needsMoreData: boolean;
}

/**
 * Wilson-ranked strongest/toughest matchup snapshot for the given
 * (already fighter-filtered) matches. Exported as a pure builder so the
 * ranking/threshold logic can be unit-tested without rendering.
 */
export function buildMatchupSnapshot(fighterMatches: Match[]): MatchupSnapshotData {
  const ranked = rankMatchupsByEvidence(fighterMatches);
  const strongest = ranked.slice(0, SNAPSHOT_COUNT);

  const qualifying = ranked.filter((row) => row.totalMatches >= TOUGHEST_MIN_GAMES);
  const toughest =
    qualifying.length >= TOUGHEST_MIN_ROWS ? qualifying.slice(-SNAPSHOT_COUNT).reverse() : [];

  return {
    strongest,
    toughest,
    needsMoreData: ranked.length > 0 && qualifying.length < TOUGHEST_MIN_ROWS,
  };
}

/**
 * Fighter-scoped matchup snapshot: strongest/toughest matchups ranked by
 * Wilson lower bound, with a link into the Matchup Lab (docs/analytics-vision.md
 * Phase C). Replaces the legacy-ratio-sorted `BestWorstMatchup`.
 */
export function MatchupSnapshot({ matches }: { matches: Match[] }) {
  const { t } = useTranslation();
  const { fighter } = useDashboardContext();
  const subjectPath = useSubjectPath();

  if (!fighter || matches.length === 0) {
    return (
      <Card>
        <CardContent className="pt-6">
          <h2 className="text-lg font-medium">{t('dashboard.snapshot.noMatches')}</h2>
        </CardContent>
      </Card>
    );
  }

  const fighterMatches = filterByFighter(matches, fighter.id);
  const { strongest, toughest, needsMoreData } = buildMatchupSnapshot(fighterMatches);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>{t('dashboard.snapshot.title')}</CardTitle>
        <Button asChild variant="outline" size="sm">
          <Link to={subjectPath('/matchups')}>{t('dashboard.snapshot.openLab')}</Link>
        </Button>
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <MatchupList
          title={t('dashboard.snapshot.strongest')}
          entries={strongest}
          emptyHint={t('dashboard.snapshot.notEnough')}
        />
        <MatchupList
          title={t('dashboard.snapshot.toughest')}
          entries={toughest}
          emptyHint={
            needsMoreData
              ? t('dashboard.snapshot.needMoreGames', { count: TOUGHEST_MIN_GAMES })
              : t('dashboard.snapshot.notEnough')
          }
        />
      </CardContent>
    </Card>
  );
}

function MatchupList({
  title,
  entries,
  emptyHint,
}: {
  title: string;
  entries: RankedMatchup[];
  emptyHint: string;
}) {
  const { t } = useTranslation();
  return (
    <div>
      <h3 className="mb-2 text-sm text-muted-foreground">{title}</h3>
      {entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">{emptyHint}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {entries.map((entry) => {
            const sprite = getFighterById(entry.opponentFighterId);
            return (
              <li key={entry.opponentFighterId} className="flex items-center gap-2">
                {sprite && <img src={sprite.url} alt="" className="size-10 object-contain" />}
                <div>
                  <div className="font-medium">
                    {sprite
                      ? localizedFighterName(entry.opponentFighterId, t)
                      : t('common.unknown')}
                  </div>
                  <div className="text-sm text-muted-foreground">
                    {entry.wins}-{entry.losses} &middot; {entry.ratio}% ({entry.totalMatches})
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
