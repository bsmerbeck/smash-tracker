import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pencil, Trash2 } from 'lucide-react';
import type { GspEntry } from '@smash-tracker/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatDate, formatGrouped, formatSigned } from '@/lib/format';
import { cn } from '@/lib/utils';

/** Rows shown before the "Show all" toggle — enough to catch a recent typo without burying the page. */
const DEFAULT_VISIBLE_ROWS = 8;

/** The log's own date form: `Jan 3, 2026`. */
const LOG_DATE_OPTIONS: Intl.DateTimeFormatOptions = {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
};

/**
 * V14: compact log of the entries behind the selected fighter's GSP series,
 * newest first, with per-row edit/delete — so fixing a flubbed digit happens
 * right here instead of a round-trip through Match Data. V17: rows are
 * `GspEntry`s — matches show a Win/Loss badge, standalone calibration
 * readings ("set GSP without a match") show a neutral "Set" badge and no
 * delta (the drift into a re-baseline is deliberately not presented as a
 * gain/loss). The page owns the actual edit dialogs / delete confirmation
 * (shared with the curve's click-to-edit); this component only renders rows
 * and raises callbacks.
 *
 * Plan 41-06 (DD-41-12): `highlightedIndexes` (indices into `entries`) marks the rows a curve close click
 * summarises - `aria-current="true"` plus `bg-muted/40`, until the next selection replaces them. When the
 * selection changes with `forceShowAll`, the log expands past its recent rows, scrolls the first
 * highlighted row into view and moves focus to it (focusable only while highlighted).
 */
export function GspMatchLog({
  entries,
  onEdit,
  onDelete,
  highlightedIndexes,
  forceShowAll = false,
}: {
  /** Ascending-time entries behind the GSP series — `getGspEntries` output. */
  entries: GspEntry[];
  onEdit: (entry: GspEntry) => void;
  onDelete: (entry: GspEntry) => void;
  /** DD-41-12: indices into `entries` of the rows to mark (a curve close's `memberIndexes`). */
  highlightedIndexes?: number[];
  /** DD-41-12: expand to every row whenever the highlighted selection changes. */
  forceShowAll?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const [showAll, setShowAll] = useState(forceShowAll && highlightedIndexes !== undefined);
  const listRef = useRef<HTMLUListElement>(null);

  // Adjusting state when a prop changes (React's documented pattern): a new selection expands the log in
  // the SAME render, so the highlighted row exists by the time the effect below focuses it.
  const [seenHighlight, setSeenHighlight] = useState(highlightedIndexes);
  if (highlightedIndexes !== seenHighlight) {
    setSeenHighlight(highlightedIndexes);
    if (forceShowAll && highlightedIndexes !== undefined) setShowAll(true);
  }

  useEffect(() => {
    if (highlightedIndexes === undefined) return;
    const first = listRef.current?.querySelector<HTMLElement>('[aria-current="true"]');
    if (!first) return;
    first.scrollIntoView?.({ block: 'nearest' });
    first.focus({ preventScroll: true });
  }, [highlightedIndexes]);

  if (entries.length === 0) {
    return null;
  }

  // Delta needs the previous (older) reading, so compute in ascending order
  // and only then flip to newest-first for display.
  const rows = entries
    .map((entry, i) => ({
      entry,
      index: i,
      // A calibration row shows no delta: the jump into a re-baseline is
      // exactly the drift the feature exists to keep out of the numbers.
      delta: i > 0 && entry.kind === 'match' ? entry.gsp - entries[i - 1]!.gsp : null,
    }))
    .reverse();
  const visibleRows = showAll ? rows : rows.slice(0, DEFAULT_VISIBLE_ROWS);
  const highlighted = new Set(highlightedIndexes);

  return (
    <Card className="gap-4 py-4 shadow-none sm:py-5">
      <CardHeader className="px-4 sm:px-5">
        <CardTitle>{t('gsp.log.title')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 px-4 sm:px-5">
        <ul ref={listRef} className="flex flex-col gap-2">
          {visibleRows.map(({ entry, delta, index }) => {
            const isHighlighted = highlighted.has(index);
            return (
              <li
                key={`${entry.kind}-${entry.kind === 'match' ? entry.match.id : entry.reading.id}`}
                aria-current={isHighlighted ? 'true' : undefined}
                tabIndex={isHighlighted ? -1 : undefined}
                className={cn(
                  'flex items-center justify-between gap-2 rounded-md border p-2',
                  isHighlighted &&
                    'bg-muted/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
                )}
              >
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="w-24 text-xs text-muted-foreground">
                    {formatDate(entry.time, i18n.language, LOG_DATE_OPTIONS)}
                  </span>
                  {entry.kind === 'match' ? (
                    <Badge variant={entry.win ? 'success' : 'destructive'}>
                      {entry.win ? t('common.win') : t('common.loss')}
                    </Badge>
                  ) : (
                    <Badge variant="secondary">{t('gsp.log.setBadge')}</Badge>
                  )}
                  <span className="font-medium tabular-nums">
                    {formatGrouped(entry.gsp, i18n.language)}
                  </span>
                  {delta !== null && (
                    <span
                      className={`text-xs tabular-nums ${delta >= 0 ? 'text-emerald-500' : 'text-destructive'}`}
                    >
                      {formatSigned(delta, i18n.language)}
                    </span>
                  )}
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="icon-sm"
                    aria-label={t('gsp.log.editEntry', {
                      date: formatDate(entry.time, i18n.language, LOG_DATE_OPTIONS),
                    })}
                    onClick={() => onEdit(entry)}
                  >
                    <Pencil />
                  </Button>
                  <Button
                    variant="outline"
                    size="icon-sm"
                    aria-label={t('gsp.log.deleteEntry', {
                      date: formatDate(entry.time, i18n.language, LOG_DATE_OPTIONS),
                    })}
                    onClick={() => onDelete(entry)}
                  >
                    <Trash2 />
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
        {rows.length > DEFAULT_VISIBLE_ROWS && (
          <Button
            variant="ghost"
            size="sm"
            className="self-center"
            onClick={() => setShowAll((prev) => !prev)}
          >
            {showAll ? t('gsp.log.showRecent') : t('gsp.log.showAll', { count: rows.length })}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
