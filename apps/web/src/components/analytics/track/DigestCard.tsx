import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { CardSkeleton } from '@/components/analytics/CardSkeleton';
import { InsightLine } from '@/components/analytics/InsightLine';
import { StatFigure, StatRow } from '@/components/analytics/StatRow';
import type { UseDigestResult } from '@/hooks/useDigest';

/** The `overline` role (UI-SPEC 5). */
const OVERLINE =
  'text-[0.6875rem] leading-4 font-semibold tracking-wider text-muted-foreground uppercase';

const TITLE_ID = 'digest-title';

export interface DigestCardProps {
  /** The one `useDigest()` result the Dashboard owns, so the card and the Tracked section never run two writers. */
  digest: UseDigestResult;
  /**
   * T-01: reserved for Phase 40's pre-event nudge. It renders after the
   * summary and is passed by nobody in 39.2 — the slot exists so Phase 40 adds
   * a line, not a card.
   */
  nudge?: ReactNode;
}

/**
 * TRK-01 / T-03 (UI-SPEC 7.9): the since-last-visit digest. Expanded it reads
 * three counts (new games, new events, tracked moved) with no chips; when
 * nothing is new it collapses to a designed quiet line with no button; on a
 * device's first visit it says so. It never renders a `StatRow` of zeros and
 * never renders counts before the matches have settled.
 */
export function DigestCard({ digest, nudge }: DigestCardProps) {
  const { t, i18n } = useTranslation();
  const loadingLabel = t('dashboard.loading');

  if (digest.status === 'loading') {
    return <CardSkeleton variant="stat-row" rows={3} statusLabel={loadingLabel} />;
  }

  const numbers = new Intl.NumberFormat(i18n.language);
  const date =
    digest.since === null
      ? null
      : new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium' }).format(digest.since);
  const sinceLabel = date === null ? null : t('digest.since', { date });
  const title = t('digest.title');
  const deviceNote = t('digest.deviceNote');

  function handleMarkRead() {
    if (!digest.canMarkAsRead) return;
    digest.markAsRead();
    toast(t('digest.markedToast'));
  }

  let body: ReactNode;
  if (digest.status === 'start') {
    body = <InsightLine tone="steady" text={t('digest.start')} />;
  } else if (digest.status === 'quiet') {
    body = <InsightLine tone="steady" text={t('digest.quiet', { date: date ?? '' })} />;
  } else {
    // Each label is resolved in its own statement (insightCopy guard: two
    // translation calls never meet inside one expression).
    const gamesLabel = t('digest.newGames');
    const eventsLabel = t('digest.newEvents');
    const movedLabel = t('digest.moved');
    const figures = [
      <StatFigure key="games" lead label={gamesLabel} value={numbers.format(digest.newGames)} />,
      <StatFigure key="events" label={eventsLabel} value={numbers.format(digest.newEvents)} />,
      <StatFigure key="moved" label={movedLabel} state="empty" />,
    ];
    body = (
      <>
        <StatRow figures={figures} leadWidth leadSpanOnPhone />
        {nudge}
      </>
    );
  }

  return (
    <section
      id="digest"
      data-slot="digest-card"
      data-state={digest.status}
      aria-labelledby={TITLE_ID}
    >
      <Card className="gap-4 p-5 shadow-none">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
            <h2 id={TITLE_ID} className={OVERLINE} title={deviceNote}>
              {title}
            </h2>
            {sinceLabel && (
              <p data-slot="digest-since" className="text-xs leading-4 text-muted-foreground">
                {sinceLabel}
              </p>
            )}
          </div>
          {digest.status === 'expanded' && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-slot="digest-mark-read"
              disabled={!digest.canMarkAsRead}
              onClick={handleMarkRead}
            >
              {t('digest.markRead')}
            </Button>
          )}
        </div>
        <div
          key={digest.status}
          data-slot="digest-body"
          className="flex animate-in flex-col gap-4 fade-in-0 duration-[120ms] motion-reduce:animate-none"
        >
          {body}
        </div>
      </Card>
    </section>
  );
}
