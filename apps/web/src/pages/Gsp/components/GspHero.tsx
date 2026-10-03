import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pencil, Check, X } from 'lucide-react';
import type { GspPoint, GspSettings } from '@smash-tracker/shared';
import { GSP_MODEL } from '@smash-tracker/shared';
import { toast } from 'sonner';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { StatFigure, StatRow } from '@/components/analytics/StatRow';
import { useUpdateGspSettings } from '@/hooks/useGspSettings';
import { formatDate, formatGrouped } from '@/lib/format';
import { formatPercent } from '@/lib/formatPercent';
import { parseGspNumber } from '../lib/parseGspNumber';
import { GSP_MMR_DOC_URL, computedEliteThreshold, estimateMmrAt } from '../lib/gspMmrModel';
import { useGspLive } from '@/hooks/useGspLive';
import { useModelCalibration } from '../lib/useModelCalibration';
import { useNowMs } from '../lib/useNowMs';

const ELITEGSP_URL = 'https://elitegsp.com';

/** The kit's compact card density (`ChartCard`'s literal classes — UI-SPEC §6.2), applied by className composition. */
const HERO_CARD_CLASS = 'gap-4 py-4 shadow-none sm:py-5';
const HERO_CONTENT_CLASS = 'px-4 sm:px-5';

/**
 * Recent-window win rate (as a 0-1 fraction) over the trailing `windowSize`
 * GSP-bearing MATCHES. Calibration points (`win: null` — V17's "set GSP
 * without a match") are not matches and are excluded before windowing.
 */
export function getRecentGspWinRate(series: GspPoint[], windowSize = 20): number | null {
  const matchPoints = series.filter((p) => p.win !== null);
  if (matchPoints.length === 0) return null;
  const recent = matchPoints.slice(-windowSize);
  const wins = recent.filter((p) => p.win).length;
  return wins / recent.length;
}

/**
 * GSP page hero (V10.1, rebuilt on the one stat idiom by plan 41-05, C2 /
 * DD-41-17): ONE compact card holding a five-figure `StatRow` — the current
 * GSP reading (lead), the estimated hidden MMR behind it (community
 * reverse-engineered model — see packages/shared/src/gspMmr.ts), the COMPUTED
 * Elite Smash threshold (still editable — an edit recalibrates the model's
 * time-drift parameter rather than pinning the displayed value), distance to
 * Elite on the MMR scale (Elite entry is a fixed MMR, 1142, unlike the
 * ever-drifting GSP threshold) or the plain figure "Elite" at/above it, and
 * the recent GSP win rate. Text never wears a data colour: the tail-reading
 * caveat is a muted meta line.
 */
export function GspHero({ series, settings }: { series: GspPoint[]; settings: GspSettings }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const lastPoint = series.length > 0 ? series[series.length - 1]! : null;
  const winRate = getRecentGspWinRate(series);

  const calibration = useModelCalibration(settings);
  const estimate =
    lastPoint !== null ? estimateMmrAt(lastPoint.gsp, lastPoint.time, calibration) : null;
  const roundedMmr = estimate !== null ? Math.round(estimate.mmr) : null;
  const isElite = roundedMmr !== null && roundedMmr >= GSP_MODEL.ELITE_MMR;
  const noGsp = t('gsp.hero.noGsp');

  const figures = [
    lastPoint !== null ? (
      <StatFigure
        key="current"
        lead
        label={t('gsp.hero.currentGsp')}
        value={formatGrouped(lastPoint.gsp, locale)}
        support={t('gsp.hero.latestReadingDated', {
          date: formatDate(lastPoint.time, locale, { dateStyle: 'medium' }),
        })}
      />
    ) : (
      <StatFigure
        key="current"
        lead
        label={t('gsp.hero.currentGsp')}
        state="empty"
        emptyCaption={noGsp}
      />
    ),

    estimate !== null && roundedMmr !== null ? (
      <StatFigure
        key="estMmr"
        label={t('gsp.hero.estMmr')}
        value={formatGrouped(roundedMmr, locale)}
        support={
          <>
            <span className="block">
              <a
                href={GSP_MMR_DOC_URL}
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-2 hover:text-foreground"
              >
                {t('gsp.hero.modelLink')}
              </a>{' '}
              {t('gsp.hero.modelAccuracy')}
            </span>
            {estimate.zone !== 'main' && (
              <span className="block">{t('gsp.hero.tailReading', { zone: estimate.zone })}</span>
            )}
          </>
        }
      />
    ) : (
      <StatFigure key="estMmr" label={t('gsp.hero.estMmr')} state="empty" emptyCaption={noGsp} />
    ),

    <EliteThresholdFigure key="elite" settings={settings} />,

    roundedMmr === null ? (
      <StatFigure
        key="distance"
        label={t('gsp.hero.distanceToElite')}
        state="empty"
        emptyCaption={noGsp}
      />
    ) : isElite ? (
      <StatFigure
        key="distance"
        label={t('gsp.hero.distanceToElite')}
        value={t('gsp.hero.eliteValue')}
        support={t('gsp.hero.atElite', {
          mmr: formatGrouped(roundedMmr, locale),
          elite: GSP_MODEL.ELITE_MMR,
        })}
      />
    ) : (
      <StatFigure
        key="distance"
        label={t('gsp.hero.distanceToElite')}
        value={formatGrouped(GSP_MODEL.ELITE_MMR - roundedMmr, locale)}
        unitSuffix={t('gsp.hero.mmrUnit')}
        support={t('gsp.hero.belowElite', {
          mmr: formatGrouped(roundedMmr, locale),
          elite: GSP_MODEL.ELITE_MMR,
        })}
      />
    ),

    winRate !== null ? (
      <StatFigure
        key="winRate"
        label={t('gsp.hero.recentWinRate')}
        value={formatPercent(winRate, locale)}
        support={t('gsp.hero.lastNGames', {
          // Count only match points — calibration readings aren't games.
          count: Math.min(series.filter((p) => p.win !== null).length, 20),
        })}
      />
    ) : (
      <StatFigure
        key="winRate"
        label={t('gsp.hero.recentWinRate')}
        state="empty"
        emptyCaption={noGsp}
      />
    ),
  ];

  return (
    <Card className={HERO_CARD_CLASS}>
      {/* The content root (not the Card — which keeps data-slot="card" for the
          stretch oracle) is the hero's measurement target. */}
      <CardContent className={HERO_CONTENT_CLASS} data-slot="gsp-hero">
        <StatRow figures={figures} leadWidth leadSpanOnPhone />
      </CardContent>
    </Card>
  );
}

/**
 * V10.1: shows the COMPUTED current Elite entry GSP — Elite is a fixed MMR
 * (1142), so the GSP threshold is derived from the model's time-drift
 * parameter t, recalibrated by the user's most recent edit (stored via the
 * same settings API as V10; `eliteThreshold` + `updatedAt` double as the
 * calibration point, no schema change). Editing no longer pins the displayed
 * number — it feeds the model a fresh (value, timestamp) observation and the
 * display keeps drifting forward from there, same as the real threshold does.
 * The edit handlers (`parseGspNumber`, `useUpdateGspSettings`) are the ones
 * the standalone card used (T-41-13: no new parsing).
 */
function EliteThresholdFigure({ settings }: { settings: GspSettings }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(settings.eliteThreshold));
  const updateSettings = useUpdateGspSettings();

  const nowMs = useNowMs();
  const { data: live } = useGspLive();
  const calibration = useModelCalibration(settings);
  const computed = computedEliteThreshold(nowMs, calibration);

  // V17.1: say which observation is actually calibrating the number — the
  // live gsptiers.com reading wins whenever it's newer than the manual edit
  // (matching bestCalibration's pick).
  const liveActive =
    live != null && (settings.updatedAt <= 0 || live.fetchedAt >= settings.updatedAt);
  const calibrationLabel = liveActive
    ? t('gsp.hero.liveCalibrated', { date: formatDate(live.fetchedAt, locale) })
    : settings.updatedAt > 0
      ? t('gsp.hero.recalibrated', { date: formatDate(settings.updatedAt, locale) })
      : t('gsp.hero.fromAnchor');

  async function save() {
    const parsed = parseGspNumber(draft);
    if (parsed === null || parsed <= 0) {
      toast.error(t('gsp.hero.invalidThreshold'));
      return;
    }
    try {
      await updateSettings.mutateAsync({ eliteThreshold: parsed });
      toast.success(t('gsp.hero.recalibratedToast'));
      setEditing(false);
    } catch {
      toast.error(t('gsp.hero.thresholdSaveFailed'));
    }
  }

  const value = editing ? (
    <span className="inline-flex items-center gap-1">
      {/* type="text": browsers reject comma pastes into type="number",
          and the whole point is pasting straight from elitegsp.com. */}
      <Input
        type="text"
        inputMode="numeric"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        aria-label={t('gsp.hero.thresholdAria')}
        className="h-8 w-32"
        autoFocus
      />
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        aria-label={t('gsp.hero.saveThreshold')}
        onClick={() => void save()}
        disabled={updateSettings.isPending}
      >
        <Check className="size-3.5" />
      </Button>
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        aria-label={t('gsp.hero.cancelThreshold')}
        onClick={() => {
          setDraft(String(settings.eliteThreshold));
          setEditing(false);
        }}
      >
        <X className="size-3.5" />
      </Button>
    </span>
  ) : (
    <span className="inline-flex items-center gap-1.5">
      {formatGrouped(computed, locale)}
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        aria-label={t('gsp.hero.editThreshold')}
        onClick={() => setEditing(true)}
      >
        <Pencil className="size-3.5" />
      </Button>
    </span>
  );

  return (
    <StatFigure
      label={t('gsp.hero.eliteThreshold')}
      value={value}
      support={
        <>
          {t('gsp.hero.computedCaption', { calibration: calibrationLabel })}{' '}
          <a
            href={ELITEGSP_URL}
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-2 hover:text-foreground"
          >
            elitegsp.com
          </a>
        </>
      }
    />
  );
}
