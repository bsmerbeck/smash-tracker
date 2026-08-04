import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { Match } from '@smash-tracker/shared';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { formatTimestamp } from '@/lib/vod';

export interface ReviewGroundingCardProps {
  /** The event's matches, with `vodTimestamps` already normalized on each `Match`. */
  eventMatches: Match[];
}

function hasAnnotations(match: Match): boolean {
  return (match.vodTimestamps?.length ?? 0) > 0 || (match.tags?.length ?? 0) > 0;
}

/**
 * The free post-event review's read-only grounding card (REV-01/REV-02):
 * displays the event's stored VOD timestamps and tags as evidence — no
 * inline annotation editing (locked). Every timestamp chip here is a
 * STATIC `font-mono text-xs` chip, deliberately NOT the interactive
 * `CitationChip` (that component is reserved for delivered synthesis-plan
 * citations, 28-09) — this card only links out to the VOD Manager at the
 * match-selection level (`/vod?match=<matchId>`, the confirmed URL-driven
 * selection param; no `seconds`/seek param exists).
 */
export function ReviewGroundingCard({ eventMatches }: ReviewGroundingCardProps) {
  const { t, i18n } = useTranslation();

  const annotatedMatches = eventMatches.filter(hasAnnotations);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('postEvent.grounding.title')}</CardTitle>
        <CardDescription>{t('postEvent.grounding.description')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {annotatedMatches.length === 0 ? (
          <div className="flex flex-col items-center gap-1 py-6 text-center">
            <h3 className="text-sm font-medium">{t('postEvent.grounding.empty.title')}</h3>
            <p className="text-sm text-muted-foreground">{t('postEvent.grounding.empty.body')}</p>
            <Button asChild variant="outline" size="sm" className="mt-2">
              <Link to="/vod">{t('postEvent.grounding.empty.cta')}</Link>
            </Button>
          </div>
        ) : (
          annotatedMatches.map((match) => {
            const timestamps = match.vodTimestamps ?? [];
            const tags = match.tags ?? [];
            return (
              <div key={match.id} className="flex flex-col gap-2 rounded-md border p-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex flex-col">
                    <span className="text-sm font-medium">
                      {match.opponent ? `vs ${match.opponent}` : ''}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {new Date(match.time).toLocaleDateString(i18n.language)}
                    </span>
                  </div>
                  <Button asChild variant="link" size="sm">
                    <Link to={`/vod?match=${match.id}`}>
                      {t('postEvent.grounding.annotateLink')}
                    </Link>
                  </Button>
                </div>
                {timestamps.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {timestamps.map((stamp) => (
                      <span
                        key={stamp.id}
                        className="rounded border border-muted-foreground/30 px-1.5 py-0.5 font-mono text-xs text-muted-foreground"
                      >
                        {formatTimestamp(stamp.seconds)}
                      </span>
                    ))}
                  </div>
                )}
                {tags.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {tags.map((tag) => (
                      <Badge key={tag} variant="outline">
                        {tag}
                      </Badge>
                    ))}
                  </div>
                )}
              </div>
            );
          })
        )}
      </CardContent>
    </Card>
  );
}
