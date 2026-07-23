import { useTranslation } from 'react-i18next';
import type { Match } from '@smash-tracker/shared';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { getFighterById } from '@/data/sprites';
import { localizedFighterName } from '@/lib/fighterNames';
import { buildMatchupCoverage, buildPracticeRecommendations } from '../lib/matchupCoverage';

/**
 * Up to 3 data-driven practice bullets for the selected fighter: worst
 * qualifying matchup, biggest coverage gap, and worst stage habit — each
 * omitted when its trigger condition isn't met, with an honest empty state
 * when none apply yet.
 */
export function PracticeRecommendations({
  allFilteredMatches,
  fighterMatches,
}: {
  allFilteredMatches: Match[];
  fighterMatches: Match[];
}) {
  const { t } = useTranslation();
  const coverage = buildMatchupCoverage(allFilteredMatches, fighterMatches);
  const recs = buildPracticeRecommendations(
    fighterMatches,
    coverage,
    (fighterId) =>
      getFighterById(fighterId) ? localizedFighterName(fighterId, t) : t('common.unknown'),
    t,
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('fighterAnalysis.practice.title')}</CardTitle>
      </CardHeader>
      <CardContent>
        {recs.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('fighterAnalysis.practice.empty')}</p>
        ) : (
          <ul className="flex flex-col gap-2 text-sm">
            {recs.map((rec) => (
              <li key={rec.kind} className="flex items-start gap-2">
                <span aria-hidden="true">&bull;</span>
                <span>{rec.text}</span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
