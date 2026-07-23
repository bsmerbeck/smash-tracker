import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Swords } from 'lucide-react';
import type {
  Match,
  MyCharacterRecordVsOpponent,
  ScoutCharacterUsage,
} from '@smash-tracker/shared';
import { rankMatchup, selectMyCandidateFighterIds, type MatchupPick } from '@smash-tracker/shared';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { getFighterById } from '@/data/sprites';
import { useFighterName, useFighterNameResolver } from '@/hooks/useFighterName';
import { useFighters } from '@/hooks/useFighters';

const MAX_OPPONENT_ROWS = 5;
const MY_TOP_CHARACTERS_COUNT = 5;

interface AdvisorRow {
  opponentFighterId: number;
  opponentGames: number;
  best: MatchupPick;
  worst: MatchupPick | null;
}

function PickChip({ pick, tone }: { pick: MatchupPick; tone: 'best' | 'worst' }) {
  const { t } = useTranslation();
  const sprite = getFighterById(pick.fighterId);
  const localizedName = useFighterName(pick.fighterId);
  const evidenceParts: string[] = [];
  if (pick.evidence.record) {
    evidenceParts.push(t('scout.advisor.inYourSets', { record: pick.evidence.record }));
  }
  evidenceParts.push(t('scout.advisor.tier', { score: pick.evidence.tierScore.toFixed(1) }));
  if (pick.evidence.archetypeEdge > 0) {
    evidenceParts.push(t('scout.advisor.archetypeEdge'));
  } else if (pick.evidence.archetypeEdge < 0) {
    evidenceParts.push(t('scout.advisor.archetypeDisadvantage'));
  }

  return (
    <div className="flex items-center gap-2">
      {sprite ? (
        <img src={sprite.url} alt="" className="size-6 object-contain" />
      ) : (
        <span className="flex size-6 items-center justify-center rounded bg-muted text-[10px] font-semibold text-muted-foreground">
          ?
        </span>
      )}
      <div className="flex flex-col leading-tight">
        <span className={`text-sm font-medium ${tone === 'worst' ? 'text-muted-foreground' : ''}`}>
          {sprite ? localizedName : t('common.unknown')}
        </span>
        <span className="text-xs text-muted-foreground">{evidenceParts.join(' · ')}</span>
      </div>
    </div>
  );
}

/**
 * V9-B Feature 3: deterministic (zero AI cost) character-pick advisor —
 * "who should I play against each of their characters", ranked by the
 * shared `matchupAdvisor.ts` blend of the user's own W/L record with
 * tier-list/archetype priors. Placed between the AI-report area and
 * Character Usage on the scout result.
 *
 * Hidden rows: opponent characters with `fighterId === 0` (unmapped) are
 * excluded — there's nothing to advise against for "unknown character".
 * Empty state: when the scout has no character data at all (common for
 * parry.gg's younger/sparser match data), says so plainly rather than
 * rendering an empty table.
 */
export function ScoutMatchupAdvisorCard({
  scoutedCharacters,
  matches,
}: {
  scoutedCharacters: ScoutCharacterUsage[];
  matches: Match[];
}) {
  const { t } = useTranslation();
  const localizedName = useFighterNameResolver();
  const { data: fighters } = useFighters();

  const myFighterIds = useMemo(
    () =>
      selectMyCandidateFighterIds(
        matches.map((m) => m.fighter_id),
        fighters?.primary ?? [],
        fighters?.secondary ?? [],
        MY_TOP_CHARACTERS_COUNT,
      ),
    [fighters, matches],
  );

  const opponentFighterIds = useMemo(
    () =>
      scoutedCharacters
        .filter((c) => c.fighterId !== 0)
        .slice(0, MAX_OPPONENT_ROWS)
        .map((c) => c.fighterId),
    [scoutedCharacters],
  );

  const rows: AdvisorRow[] = useMemo(() => {
    if (myFighterIds.length === 0) {
      return [];
    }
    return opponentFighterIds.flatMap((opponentFighterId) => {
      const records: MyCharacterRecordVsOpponent[] = myFighterIds.map((fighterId) => {
        const vsMatches = matches.filter(
          (m) => m.fighter_id === fighterId && m.opponent_id === opponentFighterId,
        );
        const wins = vsMatches.filter((m) => m.win).length;
        return { fighterId, wins, losses: vsMatches.length - wins };
      });
      const ranking = rankMatchup(opponentFighterId, myFighterIds, records);
      if (!ranking.best) {
        return [];
      }
      const opponentGames =
        scoutedCharacters.find((c) => c.fighterId === opponentFighterId)?.games ?? 0;
      return [
        {
          opponentFighterId,
          opponentGames,
          best: ranking.best,
          worst: ranking.worst,
        },
      ];
    });
  }, [matches, myFighterIds, opponentFighterIds, scoutedCharacters]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Swords className="size-4" />
          {t('scout.advisor.title')}
        </CardTitle>
        <CardDescription>{t('scout.advisor.description')}</CardDescription>
      </CardHeader>
      <CardContent>
        {opponentFighterIds.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('scout.advisor.noCharacterData')}</p>
        ) : myFighterIds.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('scout.advisor.noMyCharacters')}</p>
        ) : (
          <ul className="flex flex-col gap-4">
            {rows.map((row) => (
              <li
                key={row.opponentFighterId}
                className="flex flex-col gap-2 border-b pb-4 last:border-b-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="flex items-center gap-2">
                  {(() => {
                    const opponentSprite = getFighterById(row.opponentFighterId);
                    return opponentSprite ? (
                      <img src={opponentSprite.url} alt="" className="size-7 object-contain" />
                    ) : (
                      <span className="flex size-7 items-center justify-center rounded bg-muted text-[10px] font-semibold text-muted-foreground">
                        ?
                      </span>
                    );
                  })()}
                  <div className="flex flex-col leading-tight">
                    <span className="text-sm font-medium">
                      {t('scout.advisor.vsName', {
                        name: getFighterById(row.opponentFighterId)
                          ? localizedName(row.opponentFighterId)
                          : t('common.unknown'),
                      })}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {t('scout.advisor.gamesSampled', { count: row.opponentGames })}
                    </span>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-4">
                  <PickChip pick={row.best} tone="best" />
                  {row.worst && <PickChip pick={row.worst} tone="worst" />}
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
