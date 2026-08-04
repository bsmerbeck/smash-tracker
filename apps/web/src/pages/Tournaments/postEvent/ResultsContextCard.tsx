import { useTranslation } from 'react-i18next';
import type { Match } from '@smash-tracker/shared';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

export interface ResultsContextCardProps {
  /** Rows resolved by `entryKey` — synced-by-entryKey, never labeled as inferred. */
  synced: Match[];
  /** Alias-inferred manual rows — always carry the provenance badge (owner guardrail, INV-8). */
  manual: Match[];
}

interface ResultsRow {
  match: Match;
  isManual: boolean;
}

/**
 * The free post-event review's results card (REV-01/REV-02). Takes
 * `selectReviewResultsContext`'s `{ synced, manual }` output directly — the
 * PAGE runs the selector (28-10), this card never fetches. Rows merge the
 * two lists chronologically for display.
 *
 * Owner guardrail (INV-8, verbatim): "manually associated matches found
 * through curated opponent aliases should be visibly identified as
 * inferred/manual context." Every `manual` row renders the outline "Manual"
 * badge — wrapped in a tooltip whose text also feeds the badge's
 * `aria-label` so the provenance is available non-visually — on EVERY row,
 * always, never collapsed away at any breakpoint. Synced-by-entryKey rows
 * render no badge at all: unlabeled = synced.
 */
export function ResultsContextCard({ synced, manual }: ResultsContextCardProps) {
  const { t, i18n } = useTranslation();

  const rows: ResultsRow[] = [
    ...synced.map((match): ResultsRow => ({ match, isManual: false })),
    ...manual.map((match): ResultsRow => ({ match, isManual: true })),
  ].sort((a, b) => a.match.time - b.match.time);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('postEvent.results.title')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {rows.length === 0 ? (
          <div className="flex flex-col items-center gap-1 py-6 text-center">
            <h3 className="text-sm font-medium">{t('postEvent.results.empty.title')}</h3>
            <p className="text-sm text-muted-foreground">{t('postEvent.results.empty.body')}</p>
          </div>
        ) : (
          rows.map(({ match, isManual }) => (
            <div
              key={match.id}
              className="flex items-center justify-between gap-3 rounded-md border p-3"
            >
              <div className="flex flex-col">
                <span className="text-sm font-medium">{match.opponent ?? ''}</span>
                <span className="text-xs text-muted-foreground">
                  {new Date(match.time).toLocaleDateString(i18n.language)}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant={match.win ? 'success' : 'destructive'}>
                  {match.win ? t('common.win') : t('common.loss')}
                </Badge>
                {isManual && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Badge variant="outline" aria-label={t('postEvent.results.inferredTooltip')}>
                        {t('postEvent.results.inferredBadge')}
                      </Badge>
                    </TooltipTrigger>
                    <TooltipContent>{t('postEvent.results.inferredTooltip')}</TooltipContent>
                  </Tooltip>
                )}
              </div>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
