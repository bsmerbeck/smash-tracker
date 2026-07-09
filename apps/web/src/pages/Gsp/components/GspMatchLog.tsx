import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pencil, Trash2 } from 'lucide-react';
import type { GspEntry } from '@smash-tracker/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

/** Rows shown before the "Show all" toggle — enough to catch a recent typo without burying the page. */
const DEFAULT_VISIBLE_ROWS = 8;

function formatDate(time: number, locale: string): string {
  return new Date(time).toLocaleDateString(locale, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

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
 */
export function GspMatchLog({
  entries,
  onEdit,
  onDelete,
}: {
  /** Ascending-time entries behind the GSP series — `getGspEntries` output. */
  entries: GspEntry[];
  onEdit: (entry: GspEntry) => void;
  onDelete: (entry: GspEntry) => void;
}) {
  const { t, i18n } = useTranslation();
  const [showAll, setShowAll] = useState(false);

  if (entries.length === 0) {
    return null;
  }

  // Delta needs the previous (older) reading, so compute in ascending order
  // and only then flip to newest-first for display.
  const rows = entries
    .map((entry, i) => ({
      entry,
      // A calibration row shows no delta: the jump into a re-baseline is
      // exactly the drift the feature exists to keep out of the numbers.
      delta: i > 0 && entry.kind === 'match' ? entry.gsp - entries[i - 1]!.gsp : null,
    }))
    .reverse();
  const visibleRows = showAll ? rows : rows.slice(0, DEFAULT_VISIBLE_ROWS);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('gsp.log.title')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <ul className="flex flex-col gap-2">
          {visibleRows.map(({ entry, delta }) => (
            <li
              key={`${entry.kind}-${entry.kind === 'match' ? entry.match.id : entry.reading.id}`}
              className="flex items-center justify-between gap-2 rounded-md border p-2"
            >
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="w-24 text-xs text-muted-foreground">
                  {formatDate(entry.time, i18n.language)}
                </span>
                {entry.kind === 'match' ? (
                  <Badge variant={entry.win ? 'success' : 'destructive'}>
                    {entry.win ? t('common.win') : t('common.loss')}
                  </Badge>
                ) : (
                  <Badge variant="secondary">{t('gsp.log.setBadge')}</Badge>
                )}
                <span className="font-medium tabular-nums">{entry.gsp.toLocaleString()}</span>
                {delta !== null && (
                  <span
                    className={`text-xs tabular-nums ${delta >= 0 ? 'text-emerald-500' : 'text-destructive'}`}
                  >
                    {delta >= 0 ? '+' : ''}
                    {delta.toLocaleString()}
                  </span>
                )}
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="icon-sm"
                  aria-label={t('gsp.log.editEntry', {
                    date: formatDate(entry.time, i18n.language),
                  })}
                  onClick={() => onEdit(entry)}
                >
                  <Pencil />
                </Button>
                <Button
                  variant="outline"
                  size="icon-sm"
                  aria-label={t('gsp.log.deleteEntry', {
                    date: formatDate(entry.time, i18n.language),
                  })}
                  onClick={() => onDelete(entry)}
                >
                  <Trash2 />
                </Button>
              </div>
            </li>
          ))}
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
