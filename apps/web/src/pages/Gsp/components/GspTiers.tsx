import { useTranslation } from 'react-i18next';
import type { GspPoint, GspSettings, GspTierId } from '@smash-tracker/shared';
import {
  estimateT,
  getGspTierLadder,
  getGspTierPosition,
  projectMatchesToEliteMmr,
} from '@smash-tracker/shared';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { getRecentGspWinRate } from './GspHero';
import { calibrationFromSettings, estimateMmrAt } from '../lib/gspMmrModel';
import { useNowMs } from '../lib/useNowMs';

const GSPTIERS_URL = 'https://gsptiers.com';

/** Ladder rows shown above the current tier — enough for a short-term goal and the one after it. */
const ROWS_ABOVE_CURRENT = 2;

/**
 * The gsptiers.com tier ladder (see packages/shared/src/gspTiers.ts),
 * replacing V10.1's "Road to Elite" card. Community feedback drove the
 * swap: the old card burned a lot of space on a projection that was
 * meaningless for players already in Elite, while the tier ladder gives
 * everyone a short-term goal — the next tier up is a few hundred thousand
 * GSP away whether you're in Top 50% or chasing Legend. Shows a compact
 * window (current tier + the next {@link ROWS_ABOVE_CURRENT} up), progress
 * toward the next boundary, and — below Elite only — a one-line net-wins
 * projection distilled from the old card (same `projectMatchesToEliteMmr`
 * model, including its kind "equilibrium" framing for ≤50% win rates).
 */
export function GspTiers({ series, settings }: { series: GspPoint[]; settings: GspSettings }) {
  const { t } = useTranslation();
  const nowMs = useNowMs();
  const lastPoint = series.length > 0 ? series[series.length - 1]! : null;

  const calibration = calibrationFromSettings(settings);
  const ladder = getGspTierLadder(estimateT(nowMs, calibration));
  const position = lastPoint !== null ? getGspTierPosition(lastPoint.gsp, ladder) : null;

  const tierName = (id: GspTierId) => t(`gsp.tiers.names.${id}`);

  // The distilled Road-to-Elite line, only meaningful below the Elite row.
  const eliteBoundary = ladder.find((row) => row.id === 'elite')!.gsp;
  const winRate = getRecentGspWinRate(series) ?? 0;
  const estimate =
    lastPoint !== null ? estimateMmrAt(lastPoint.gsp, lastPoint.time, calibration) : null;
  const projection =
    estimate !== null && lastPoint !== null && lastPoint.gsp < eliteBoundary
      ? projectMatchesToEliteMmr(Math.round(estimate.mmr), winRate)
      : null;
  const rate = Math.round(winRate * 100);

  // Window: the current tier plus a couple of rows above it. When the
  // reading is under the whole ladder, show the bottom rows + the sentinel.
  const currentIndex =
    position === null
      ? -1
      : position.current.id === 'below'
        ? ladder.length
        : ladder.findIndex((row) => row.id === position.current.id);
  const windowStart = Math.max(0, currentIndex - ROWS_ABOVE_CURRENT);
  const windowRows = position === null ? [] : ladder.slice(windowStart, currentIndex + 1);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('gsp.tiers.title')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {position === null || lastPoint === null ? (
          <p className="text-sm text-muted-foreground">{t('gsp.tiers.empty')}</p>
        ) : (
          <>
            <ul className="flex flex-col gap-1.5">
              {windowRows.map((row) => (
                <TierRow
                  key={row.id}
                  name={tierName(row.id)}
                  caption={
                    row.id === 'god'
                      ? t('gsp.tiers.estMax')
                      : t('gsp.tiers.topPercent', { percent: row.topPercent })
                  }
                  gspLabel={row.gsp.toLocaleString()}
                  isCurrent={row.id === position.current.id}
                  youLabel={t('gsp.tiers.you')}
                />
              ))}
              {position.current.id === 'below' && (
                <TierRow
                  name={tierName('below')}
                  caption={null}
                  gspLabel={null}
                  isCurrent
                  youLabel={t('gsp.tiers.you')}
                />
              )}
            </ul>

            {position.next !== null && position.gspToNext !== null ? (
              <div className="flex flex-col gap-1">
                <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-primary"
                    style={{ width: `${Math.round((position.progressToNext ?? 0) * 100)}%` }}
                  />
                </div>
                <p className="text-sm text-muted-foreground">
                  {t('gsp.tiers.toNext', {
                    gsp: position.gspToNext.toLocaleString(),
                    tier: tierName(position.next.id),
                  })}
                </p>
              </div>
            ) : (
              <p className="text-sm font-medium text-emerald-500">{t('gsp.tiers.atCeiling')}</p>
            )}

            {projection?.status === 'projected' && (
              <p className="text-sm text-muted-foreground">
                {t('gsp.tiers.eliteProjected', { count: projection.matchesNeeded, rate })}
              </p>
            )}
            {projection?.status === 'equilibrium' && (
              <p className="text-sm text-muted-foreground">
                {t('gsp.tiers.equilibrium', { rate })}
              </p>
            )}
            {projection?.status === 'capped' && (
              <p className="text-sm text-muted-foreground">{t('gsp.tiers.capped')}</p>
            )}
          </>
        )}
        <p className="text-xs text-muted-foreground">
          {t('gsp.tiers.attributionPrefix')}{' '}
          <a
            href={GSPTIERS_URL}
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-2 hover:text-foreground"
          >
            gsptiers.com
          </a>{' '}
          {t('gsp.tiers.attributionSuffix')}
        </p>
      </CardContent>
    </Card>
  );
}

function TierRow({
  name,
  caption,
  gspLabel,
  isCurrent,
  youLabel,
}: {
  name: string;
  caption: string | null;
  /** Boundary GSP, localized — `null` for the below-ladder sentinel row (it has no boundary). */
  gspLabel: string | null;
  isCurrent: boolean;
  youLabel: string;
}) {
  return (
    <li
      className={`flex items-center justify-between gap-2 rounded-md border px-3 py-1.5 ${
        isCurrent ? 'border-primary/50 bg-primary/5' : 'border-transparent'
      }`}
    >
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className={`text-sm ${isCurrent ? 'font-semibold' : 'font-medium'}`}>{name}</span>
        {caption && <span className="text-xs text-muted-foreground">{caption}</span>}
      </div>
      <div className="flex items-center gap-2">
        {isCurrent && <Badge variant="secondary">{youLabel}</Badge>}
        {gspLabel && <span className="text-sm tabular-nums text-muted-foreground">{gspLabel}</span>}
      </div>
    </li>
  );
}
