import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type { ScoutCommonOpponent } from '@smash-tracker/shared';
import { normalizeOpponentTag } from '@smash-tracker/shared';
import { useSubjectPath } from '@/hooks/useSubjectPath';
import { buildOpponentHubPath } from '@/lib/analyzeOpponent';
import { DrillableRow, DrillableRowChevron } from '@/components/DrillableRow';

/**
 * Opponents the scouted player has faced most often in the sampled sets.
 *
 * Phase 38-07 (Q11.5/D-14): single host (`ScoutPage.tsx`), so this component
 * calls `useSubjectPath()` directly. A row's raw scouted `gamerTag` (a THIRD
 * PARTY's data — landmine Q11.5) is run through the SAME shared
 * `normalizeOpponentTag` the engine's own identity resolution uses BEFORE it
 * becomes a hub path segment, closing the case/whitespace/reserved-character
 * mismatch class. A normalized tag that matches nobody in the viewer's own
 * history lands on the hub's own disclosed empty state — that's an accepted,
 * disclosed outcome (the hub renders `opponents.hub.empty` for it), never a
 * bug or a dead link.
 */
export function ScoutCommonOpponentsCard({ opponents }: { opponents: ScoutCommonOpponent[] }) {
  const { t } = useTranslation();
  const subjectPath = useSubjectPath();
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('scout.commonOpponents.title')}</CardTitle>
        <CardDescription>{t('scout.commonOpponents.description')}</CardDescription>
      </CardHeader>
      <CardContent>
        {opponents.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('scout.commonOpponents.empty')}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {opponents.map((opponent) => {
              const destination = subjectPath(
                buildOpponentHubPath(normalizeOpponentTag(opponent.gamerTag)),
              );
              return (
                <li
                  key={opponent.gamerTag}
                  className="relative flex items-center justify-between gap-2 rounded-md hover:bg-accent"
                >
                  <DrillableRow
                    as="overlay"
                    to={destination}
                    ariaLabel={t('shared.drillableRow.aria', {
                      subject: opponent.gamerTag,
                      context: t('scout.commonOpponents.title'),
                    })}
                  />
                  <span className="text-sm">{opponent.gamerTag}</span>
                  <span className="flex shrink-0 items-center gap-2 whitespace-nowrap text-sm text-muted-foreground">
                    {t('scout.commonOpponents.sets', { count: opponent.sets })}
                    <DrillableRowChevron />
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
