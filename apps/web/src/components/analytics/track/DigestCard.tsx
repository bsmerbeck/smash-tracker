import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { CardSkeleton } from '@/components/analytics/CardSkeleton';
import { InsightLine } from '@/components/analytics/InsightLine';
import { StatFigure, StatRow } from '@/components/analytics/StatRow';
import { MUTED_LINK_TONE } from '@/components/analytics/linkTone';
import { CompactTrackedRow } from '@/components/analytics/track/TrackedRow';
import { TRACKED_SECTION_ID } from '@/components/analytics/track/TrackedSection';
import type { UseDigestResult } from '@/hooks/useDigest';
import { useSubjectPath } from '@/hooks/useSubjectPath';

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
  const subjectPath = useSubjectPath();
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
      digest.movedCount === null ? (
        // The tracked list is still resolving: a muted dash, never a zero that may be wrong.
        <StatFigure key="moved" label={movedLabel} state="empty" />
      ) : (
        <StatFigure key="moved" label={movedLabel} value={numbers.format(digest.movedCount)} />
      ),
    ];
    // The moved list (D-05, D-06), or the one muted line when games came in but nothing tracked changed.
    let movedBlock: ReactNode = null;
    if (digest.movedRows.length > 0) {
      movedBlock = (
        <div data-slot="digest-moved" className="flex flex-col gap-1">
          <ul data-slot="digest-moved-list" className="flex flex-col">
            {digest.movedRows.map((model) => (
              <CompactTrackedRow key={model.itemKey} model={model} />
            ))}
          </ul>
          {digest.moreCount > 0 && (
            <div>
              <Button asChild variant="link" size="sm" className={MUTED_LINK_TONE}>
                <Link
                  data-slot="digest-more"
                  to={{ pathname: subjectPath('/dashboard'), hash: `#${TRACKED_SECTION_ID}` }}
                >
                  {t('digest.andMore', { count: digest.moreCount })}
                </Link>
              </Button>
            </div>
          )}
        </div>
      );
    } else if (digest.movedCount === 0) {
      movedBlock = (
        <p data-slot="digest-none-moved" className="text-sm leading-5 text-muted-foreground">
          {t('digest.noneMoved')}
        </p>
      );
    }
    body = (
      <>
        <StatRow figures={figures} leadWidth leadSpanOnPhone />
        {movedBlock}
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
