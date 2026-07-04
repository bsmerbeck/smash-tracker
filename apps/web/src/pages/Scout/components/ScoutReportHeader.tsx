import { ExternalLink } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import type { ScoutReportData } from '@smash-tracker/shared';

/**
 * Report header: the scouted player's gamer tag, a start.gg profile link
 * (when a slug is available), and the sample-size caption every scouting
 * report carries — "this is public data, and it's a sample, not their whole
 * history."
 */
export function ScoutReportHeader({ report }: { report: ScoutReportData }) {
  const profileUrl = report.player.userSlug ? `https://start.gg/${report.player.userSlug}` : null;

  return (
    <Card>
      <CardContent className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-2xl font-semibold tracking-tight">{report.player.gamerTag}</h2>
          {profileUrl && (
            <a
              href={profileUrl}
              target="_blank"
              rel="noreferrer"
              aria-label={`View ${report.player.gamerTag} on start.gg`}
              className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
            >
              <ExternalLink className="size-3.5" />
              start.gg profile
            </a>
          )}
        </div>
        <p className="text-sm text-muted-foreground">
          Public start.gg data · sampled last {report.sampledSets} set
          {report.sampledSets === 1 ? '' : 's'} ({report.sampledGames} game
          {report.sampledGames === 1 ? '' : 's'})
        </p>
      </CardContent>
    </Card>
  );
}
