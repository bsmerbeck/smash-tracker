import type { MouseEvent } from 'react';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { readSessionBucketsMark, readSetStripMark, type Insight } from '@smash-tracker/shared';
import { ComparisonBars } from '@/components/charts/ComparisonBars';
import { RecordBar } from '@/components/charts/inlineMarks';
import { SetStrip } from '@/components/charts/FormStrip';
import { CHART_TOKENS } from '@/components/charts/tokens';
import { formatPercent } from '@/lib/formatPercent';
import { trendsReadMarkKind } from '@/pages/Trends/components/trendsReadMarkKind';

export interface TrendsReadMarkProps {
  insight: Insight;
  /** The card's counted-games door href (from the same door builder the card's doors use). */
  gamesHref: string;
}

function rateOf(wins: number, total: number): number {
  return total > 0 ? wins / total : 0;
}

/**
 * Plan 39.1-40 (sketch 002-C "Pro desk", D-09, D-13, DD-12, UI-SPEC §7.10 -
 * §7.12): the evidence mark under a Trends read card's evidence line, drawn
 * from the insight the engine built — this component ranks, sorts and
 * recomputes nothing.
 * - TiltCost: one "Next game" dumbbell row (spot rate vs the baseline tick)
 *   linking to the card's counted games, over a 0 / 50 / 100% scale.
 * - SessionFatigue: three text rows "Games 1–10 / 11–20 / 21+" with rate and
 *   n (the verdict's own cohorts at either end).
 * - Best / Toughest record: a RecordBar of its record.
 * - LastEventRecap: a SetStrip, one tick per set.
 * Renders nothing for any other template or state (see `trendsReadMarkKind`).
 */
export function TrendsReadMark({ insight, gamesHref }: TrendsReadMarkProps) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const locale = i18n.language;
  const kind = trendsReadMarkKind(insight);

  // The kit's dumbbell row is a plain anchor (ComparisonBars); follow its
  // same-route `?claim=…#games` href in-app, like every door Link, instead of
  // reloading the page. A modified click keeps the browser default.
  function followInApp(event: MouseEvent<HTMLDivElement>) {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }
    const href = (event.target as Element).closest('a[href]')?.getAttribute('href');
    if (!href) return;
    event.preventDefault();
    navigate(href);
  }

  if (kind === 'dumbbell') {
    const recent = insight.recent;
    const baseline = insight.baseline;
    if (recent.kind !== 'evidenced' || baseline.kind !== 'evidenced') return null;
    const rate = formatPercent(recent.value.rate, locale);
    const baselineRate = formatPercent(baseline.value.rate, locale);
    return (
      <div
        className="flex flex-col gap-1"
        data-slot="trends-read-dumbbell"
        onClickCapture={followInApp}
      >
        <ComparisonBars
          mode="dumbbell"
          rows={[
            {
              key: 'nextGame',
              label: t('insights.mark.nextGame'),
              recentRecordNode: (
                <span className="text-xs leading-4 text-muted-foreground tabular-nums">
                  {t('insights.mark.rateVsBaseline', { rate, baseline: baselineRate })}
                </span>
              ),
              deltaNode: null,
              baselineRate: baseline.value.rate * 100,
              recentRate: recent.value.rate * 100,
              recentTotal: recent.value.total,
              href: gamesHref,
              ariaLabel: t('insights.mark.tiltCostRow', {
                count: recent.value.total,
                rate,
                baseline: baselineRate,
              }),
            },
          ]}
        />
        <div
          aria-hidden="true"
          data-slot="trends-read-scale"
          className="flex items-center justify-between text-[0.6875rem] text-muted-foreground tabular-nums"
        >
          <span>{formatPercent(0, locale)}</span>
          <span>{formatPercent(0.5, locale)}</span>
          <span>{formatPercent(1, locale)}</span>
        </div>
      </div>
    );
  }

  if (kind === 'sessionBuckets') {
    const data = readSessionBucketsMark(insight.mark);
    if (data === null) return null;
    const count = new Intl.NumberFormat(locale);
    return (
      <ul
        data-slot="trends-session-buckets"
        aria-label={t('insights.mark.sessionBuckets.label')}
        className="grid grid-cols-[auto_minmax(0,1fr)_auto] gap-x-2 gap-y-1.5"
      >
        {data.buckets.map((bucket) => {
          const rate = rateOf(bucket.wins, bucket.total);
          return (
            <li
              key={bucket.fromGame}
              className="col-span-3 grid grid-cols-subgrid items-center text-xs leading-4 text-muted-foreground tabular-nums"
            >
              <span className="whitespace-nowrap">
                {bucket.toGame === null
                  ? t('insights.mark.sessionBuckets.open', { from: bucket.fromGame })
                  : t('insights.mark.sessionBuckets.range', {
                      from: bucket.fromGame,
                      to: bucket.toGame,
                    })}
              </span>
              <span
                aria-hidden="true"
                className="relative h-1.5 overflow-hidden rounded-full bg-muted"
              >
                <span
                  className="absolute inset-y-0 left-0 rounded-full"
                  style={{ width: `${rate * 100}%`, backgroundColor: CHART_TOKENS.series1 }}
                />
              </span>
              <span className="whitespace-nowrap text-right">
                {t('insights.mark.bucketValue', {
                  rate: formatPercent(rate, locale),
                  count: count.format(bucket.total),
                })}
              </span>
            </li>
          );
        })}
      </ul>
    );
  }

  if (kind === 'recordBar') {
    const recent = insight.recent;
    if (recent.kind !== 'evidenced') return null;
    return (
      <div className="flex items-center" data-slot="trends-read-record-bar">
        <RecordBar wins={recent.value.wins} losses={recent.value.losses} />
      </div>
    );
  }

  if (kind === 'setStrip') {
    const data = readSetStripMark(insight.mark);
    if (data === null) return null;
    const won = data.sets.filter((set) => set.won).length;
    return (
      <div className="flex items-center" data-slot="trends-read-set-strip">
        <SetStrip
          ariaLabel={t('insights.mark.setStrip', {
            count: data.sets.length,
            won,
            lost: data.sets.length - won,
          })}
          sets={data.sets.map((set) => {
            const record = `${set.gamesWon}–${set.gamesLost}`;
            return {
              key: set.setId,
              won: set.won,
              label:
                set.opponentName === null
                  ? t('insights.mark.setTickNoOpponent', { record })
                  : t('insights.mark.setTick', { opponent: set.opponentName, record }),
            };
          })}
        />
      </div>
    );
  }

  return null;
}
