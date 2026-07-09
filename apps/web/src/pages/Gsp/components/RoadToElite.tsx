import { useTranslation } from 'react-i18next';
import { PartyPopper } from 'lucide-react';
import type { GspPoint, GspSettings } from '@smash-tracker/shared';
import {
  ASSUMED_MMR_POINTS_PER_MATCH,
  GSP_MODEL,
  MAX_PROJECTED_MATCHES,
  projectMatchesToElite,
  projectMatchesToEliteMmr,
} from '@smash-tracker/shared';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { getRecentGspWinRate } from './GspHero';
import { calibrationFromSettings, computedEliteThreshold, estimateMmrAt } from '../lib/gspMmrModel';
import { useNowMs } from '../lib/useNowMs';

/**
 * The GSP page's projection card (V10.1) — "how far to Elite Smash".
 *
 * PRIMARY: the MMR projection (`projectMatchesToEliteMmr`,
 * packages/shared/src/gspMmr.ts) — Elite entry is a fixed MMR (1142) and,
 * per the community reverse-engineered zero-sum delta system (Elo K=20),
 * even matchmaking trades ~10 MMR per match, so "net wins needed" is a
 * clean, GSP-inflation-free number. Its 'equilibrium' outcome (win rate
 * <= 50%) is an honest result presented kindly — matchmaking has found the
 * player's level, and a >50% win rate (not more grinding) is what moves it.
 *
 * SECONDARY: V10's own-history GSP decay simulation
 * (`projectMatchesToElite`, packages/shared/src/gsp.ts) as a
 * "from your own GSP history" cross-check line, when it can compute.
 */
export function RoadToElite({ series, settings }: { series: GspPoint[]; settings: GspSettings }) {
  const { t } = useTranslation();
  const nowMs = useNowMs();
  const lastPoint = series.length > 0 ? series[series.length - 1]! : null;
  const winRate = getRecentGspWinRate(series) ?? 0;

  const calibration = calibrationFromSettings(settings);
  const estimate =
    lastPoint !== null ? estimateMmrAt(lastPoint.gsp, lastPoint.time, calibration) : null;
  const mmrProjection =
    estimate !== null ? projectMatchesToEliteMmr(Math.round(estimate.mmr), winRate) : null;

  // Secondary, own-history line (V10): simulate against the COMPUTED
  // GSP threshold. Only meaningful when the primary isn't a
  // celebration/equilibrium state.
  const gspThreshold = computedEliteThreshold(nowMs, calibration);
  const decayProjection =
    lastPoint !== null && mmrProjection !== null && mmrProjection.status === 'projected'
      ? projectMatchesToElite(series, gspThreshold, winRate)
      : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('gsp.road.title')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {mmrProjection === null ? (
          <p className="text-sm text-muted-foreground">{t('gsp.road.empty')}</p>
        ) : mmrProjection.status === 'already-elite' ? (
          <div className="flex items-center gap-2 text-emerald-500">
            <PartyPopper className="size-6" />
            <p className="text-lg font-semibold">{t('gsp.road.alreadyElite')}</p>
          </div>
        ) : mmrProjection.status === 'equilibrium' ? (
          <>
            <p className="text-lg font-semibold">{t('gsp.road.equilibriumTitle')}</p>
            <p className="text-sm text-muted-foreground">
              {t('gsp.road.equilibriumBody', {
                rate: Math.round(winRate * 100),
                points: ASSUMED_MMR_POINTS_PER_MATCH,
              })}
            </p>
          </>
        ) : mmrProjection.status === 'capped' ? (
          <>
            <p className="text-2xl font-bold">
              {t('gsp.road.cappedTitle', { max: MAX_PROJECTED_MATCHES })}
            </p>
            <p className="text-sm text-muted-foreground">{t('gsp.road.cappedBody')}</p>
          </>
        ) : (
          <>
            <p className="text-2xl font-bold">
              {t('gsp.road.projected', { count: mmrProjection.matchesNeeded })}
            </p>
            <p className="text-sm text-muted-foreground">
              {t('gsp.road.projectedCaption', {
                elite: GSP_MODEL.ELITE_MMR,
                points: ASSUMED_MMR_POINTS_PER_MATCH,
                rate: Math.round(winRate * 100),
              })}
            </p>
            {decayProjection && (
              <p className="text-xs text-muted-foreground">
                {t(
                  decayProjection.matchesNeededLabel === '1'
                    ? 'gsp.road.historyOne'
                    : 'gsp.road.historyMany',
                  {
                    label: decayProjection.matchesNeededLabel,
                    model: t(
                      decayProjection.model === 'exponential-decay'
                        ? 'gsp.road.decayFit'
                        : 'gsp.road.flatFallback',
                    ),
                  },
                )}
              </p>
            )}
            <ul className="list-disc space-y-1 pl-4 text-xs text-muted-foreground">
              <li>{t('gsp.road.assumption1', { points: ASSUMED_MMR_POINTS_PER_MATCH })}</li>
              <li>{t('gsp.road.assumption2')}</li>
            </ul>
          </>
        )}
      </CardContent>
    </Card>
  );
}
