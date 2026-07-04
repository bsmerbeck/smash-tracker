import { Sparkles } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import type { GeneratedScoutReport } from '@smash-tracker/shared';

/**
 * Renders one AI-generated scouting report (V7-B). Used both for a freshly
 * generated report and for a past report selected from `ScoutPastReportsCard`
 * — same component either way, since both are just a `GeneratedScoutReport`.
 */
export function ScoutAiReportCard({ report }: { report: GeneratedScoutReport }) {
  return (
    <Card className="border-primary/30 bg-primary/5">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Sparkles className="size-4 text-primary" />
          AI Scouting Report
        </CardTitle>
        <CardDescription>{report.overview}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">Game plan</h3>
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {report.gameplan.map((item, index) => (
              <li key={index}>{item}</li>
            ))}
          </ul>
        </div>

        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">Stage strategy</h3>
          <div className="flex flex-col gap-2 text-sm">
            {report.stageStrategy.bans.length > 0 && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-muted-foreground">Bans:</span>
                {report.stageStrategy.bans.map((stage) => (
                  <Badge key={stage} variant="destructive">
                    {stage}
                  </Badge>
                ))}
              </div>
            )}
            {report.stageStrategy.picks.length > 0 && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-muted-foreground">Picks:</span>
                {report.stageStrategy.picks.map((stage) => (
                  <Badge key={stage} variant="success">
                    {stage}
                  </Badge>
                ))}
              </div>
            )}
            <p className="text-muted-foreground">{report.stageStrategy.reasoning}</p>
          </div>
        </div>

        {report.headToHead && (
          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold">Head-to-head</h3>
            <p className="text-sm text-muted-foreground">{report.headToHead}</p>
          </div>
        )}

        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">Watch for</h3>
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {report.watchFor.map((item, index) => (
              <li key={index}>{item}</li>
            ))}
          </ul>
        </div>

        <p className="text-xs text-muted-foreground">{report.confidenceNotes}</p>
      </CardContent>
    </Card>
  );
}
