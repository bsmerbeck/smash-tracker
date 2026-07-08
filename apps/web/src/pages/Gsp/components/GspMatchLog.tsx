import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pencil, Trash2 } from 'lucide-react';
import type { Match } from '@smash-tracker/shared';
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
 * V14: compact log of the readings behind the selected fighter's GSP series,
 * newest first, with per-row edit/delete — so fixing a flubbed digit happens
 * right here instead of a round-trip through Match Data's full table. The
 * page owns the actual edit dialog / delete confirmation (shared with the
 * curve's click-to-edit); this component only renders rows and raises
 * callbacks.
 */
export function GspMatchLog({
  gspMatches,
  onEdit,
  onDelete,
}: {
  /** Ascending-time matches behind the GSP series — `getGspMatches` output; every entry has `gsp` set. */
  gspMatches: Match[];
  onEdit: (match: Match) => void;
  onDelete: (match: Match) => void;
}) {
  const { t, i18n } = useTranslation();
  const [showAll, setShowAll] = useState(false);

  if (gspMatches.length === 0) {
    return null;
  }

  // Delta needs the previous (older) reading, so compute in ascending order
  // and only then flip to newest-first for display.
  const rows = gspMatches
    .map((match, i) => ({
      match,
      delta: i > 0 ? match.gsp! - gspMatches[i - 1]!.gsp! : null,
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
          {visibleRows.map(({ match, delta }) => (
            <li
              key={match.id}
              className="flex items-center justify-between gap-2 rounded-md border p-2"
            >
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="w-24 text-xs text-muted-foreground">
                  {formatDate(match.time, i18n.language)}
                </span>
                <Badge variant={match.win ? 'success' : 'destructive'}>
                  {match.win ? t('common.win') : t('common.loss')}
                </Badge>
                <span className="font-medium tabular-nums">{match.gsp!.toLocaleString()}</span>
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
                    date: formatDate(match.time, i18n.language),
                  })}
                  onClick={() => onEdit(match)}
                >
                  <Pencil />
                </Button>
                <Button
                  variant="outline"
                  size="icon-sm"
                  aria-label={t('gsp.log.deleteEntry', {
                    date: formatDate(match.time, i18n.language),
                  })}
                  onClick={() => onDelete(match)}
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
