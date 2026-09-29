import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { HorizonKey, Match } from '@smash-tracker/shared';
import { Card } from '@/components/ui/card';
import { BoundedList, LIST_CAP } from '@/components/analytics/BoundedList';
import { CardSkeleton } from '@/components/analytics/CardSkeleton';
import { TrackedRow } from '@/components/analytics/track/TrackedRow';
import {
  buildTrackedRows,
  type TrackedRowModel,
} from '@/components/analytics/track/trackedRowModel';
import { useOpponentAliases } from '@/hooks/useOpponentAliases';
import { useUntrackWatchlistItem, useWatchlist } from '@/hooks/useWatchlist';

/** The `overline` role (UI-SPEC 5). */
const OVERLINE =
  'text-[0.6875rem] leading-4 font-semibold tracking-wider text-muted-foreground uppercase';

/** The anchor "Manage tracked" (plan 39.2-10's cap refusal) lands on. */
export const TRACKED_SECTION_ID = 'tracked';

const TITLE_ID = 'tracked-title';
const COUNT_ID = 'tracked-count';

export interface TrackedSectionProps {
  /**
   * The ACTIVE SUBJECT's games with opponent aliases applied
   * (`useFilteredMatches().allMatches`). Under `/coach/:clientId` and
   * `/workspace/:tenantId` these are the client's games: this section reads no
   * other source, and in particular never the account-scoped tournament
   * registry (D-17).
   */
  matches: Match[];
  /** The page's ONE horizon (`useHorizon`); every row's chip follows it. */
  horizon: HorizonKey;
}

/**
 * TRK-02 / T-04 (UI-SPEC 7.8): the Dashboard's Tracked section — the subject's
 * watchlist as one row per item with the engine's own two-horizon read. The
 * watchlist GET is off the match hot path: while it is pending the section is
 * its own 3-row skeleton and a failure is one line, neither of which touches
 * the hero. Untracking has no confirmation (DD-15); focus moves to the next
 * row's link, or to the section heading when none remains.
 */
export function TrackedSection({ matches, horizon }: TrackedSectionProps) {
  const { t } = useTranslation();
  const watchlist = useWatchlist();
  const aliases = useOpponentAliases();
  const untrack = useUntrackWatchlistItem();
  // React Compiler forbids a bare `Date.now()` call in the render body; the
  // one clock the section reads is captured once, as the hero's is.
  const [nowMs] = useState(() => Date.now());
  const listRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  const entries = watchlist.data?.items;
  const aliasMap = aliases.data;
  const rows = useMemo(
    () =>
      entries
        ? buildTrackedRows({ entries, matches, aliasMap: aliasMap ?? {}, horizon, nowMs, t })
        : [],
    [entries, matches, aliasMap, horizon, nowMs, t],
  );

  const loadingLabel = t('dashboard.loading');
  if (watchlist.isPending) {
    return (
      <section id={TRACKED_SECTION_ID} aria-label={t('watchlist.section.title')}>
        <CardSkeleton variant="list" rows={3} statusLabel={loadingLabel} />
      </section>
    );
  }

  const count = entries?.length ?? 0;
  const title = t('watchlist.section.title');
  const countLabel = watchlist.isError ? null : t('watchlist.section.count', { count });

  function handleUntrack(model: TrackedRowModel) {
    const items = Array.from(
      listRef.current?.querySelectorAll<HTMLElement>('[data-slot="tracked-row"]') ?? [],
    );
    const index = items.findIndex((item) => item.dataset.itemKey === model.itemKey);
    const neighbour = items[index + 1] ?? items[index - 1];
    const target = neighbour?.querySelector<HTMLElement>('a') ?? headingRef.current;
    // Move focus BEFORE the row unmounts so it is never dropped on the body.
    target?.focus();
    for (const itemKey of model.itemKeys) {
      untrack.mutate({ itemKey, name: model.name });
    }
  }

  // Each label is resolved in its own statement (insightCopy guard: two
  // translation calls never meet inside one expression).
  const showAllLabel = t('analytics.list.showAll', { count: rows.length });
  const showFewerLabel = t('analytics.list.showFewer');
  const showMoreLabel = t('analytics.list.showMore50');
  const listLabels = {
    showAll: showAllLabel,
    showFewer: showFewerLabel,
    showMore: showMoreLabel,
    terminus: '',
  };

  const rowNodes = rows.map((model) => (
    <TrackedRow key={model.itemKey} model={model} onUntrack={handleUntrack} />
  ));

  let body;
  if (watchlist.isError) {
    body = (
      <p data-slot="tracked-error" role="alert" className="text-sm text-muted-foreground">
        {t('watchlist.loadError')}
      </p>
    );
  } else if (count === 0) {
    body = (
      <p data-slot="tracked-empty" className="text-sm text-muted-foreground">
        {t('watchlist.section.empty')}
      </p>
    );
  } else {
    body = (
      <div ref={listRef} data-slot="tracked-list">
        <BoundedList rows={rowNodes} cap={LIST_CAP} labels={listLabels} empty={null} />
      </div>
    );
  }

  return (
    <section
      id={TRACKED_SECTION_ID}
      data-slot="tracked-section"
      aria-labelledby={`${TITLE_ID} ${COUNT_ID}`}
    >
      <Card className="gap-4 p-5 shadow-none">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h2 id={TITLE_ID} ref={headingRef} tabIndex={-1} className={OVERLINE}>
            {title}
          </h2>
          <p
            id={COUNT_ID}
            data-slot="tracked-count"
            className="text-xs leading-4 text-muted-foreground"
          >
            {countLabel}
          </p>
        </div>
        {body}
      </Card>
    </section>
  );
}
