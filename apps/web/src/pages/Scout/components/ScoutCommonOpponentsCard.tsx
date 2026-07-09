import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type { ScoutCommonOpponent } from '@smash-tracker/shared';

/** Opponents the scouted player has faced most often in the sampled sets. */
export function ScoutCommonOpponentsCard({ opponents }: { opponents: ScoutCommonOpponent[] }) {
  const { t } = useTranslation();
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
            {opponents.map((opponent) => (
              <li key={opponent.gamerTag} className="flex items-center justify-between gap-2">
                <span className="text-sm">{opponent.gamerTag}</span>
                <span className="shrink-0 whitespace-nowrap text-sm text-muted-foreground">
                  {t('scout.commonOpponents.sets', { count: opponent.sets })}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
