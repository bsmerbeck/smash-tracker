import { Download, Printer, Sparkles } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { ScoutReportRecord } from '@smash-tracker/shared';
import { formatRelativeDate } from '@/lib/relativeDate';
import { reportMarkdownFilename, reportToMarkdown } from '../reportMarkdown';

function downloadMarkdown(record: ScoutReportRecord) {
  const markdown = reportToMarkdown(record);
  const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = reportMarkdownFilename(record);
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

/**
 * Renders one AI-generated scouting report (V7-B). Used both for a freshly
 * generated report and for a persisted/past report — same component either
 * way, since both are just a `ScoutReportRecord`.
 *
 * V7-B.1 additions:
 * - A "Generated <relative date>" line (the record's `createdAt`).
 * - Download (.md) and Print/Save-as-PDF affordances. Print reuses the
 *   `.print-packet-root` print-media rule (see `apps/web/src/index.css`,
 *   originally built for the Opponents page's H2H evidence packet) — a
 *   second, on-screen-hidden rendering of the report is included below so
 *   `window.print()` shows only this content, not app chrome or the other
 *   scout cards.
 * - A `characterStrategy` section, co-equal with stage strategy. Optional on
 *   the stored-record schema (pre-V7-B.1 reports lack it) — omitted here
 *   when absent rather than rendering an empty section.
 */
export function ScoutAiReportCard({ record }: { record: ScoutReportRecord }) {
  const { report } = record;

  return (
    <>
      <Card className="border-primary/30 bg-primary/5 print:hidden">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Sparkles className="size-4 text-primary" />
            AI Scouting Report
          </CardTitle>
          <CardDescription>{report.overview}</CardDescription>
          <p className="text-xs text-muted-foreground">
            Generated {formatRelativeDate(record.createdAt)}
          </p>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => downloadMarkdown(record)}
            >
              <Download />
              Download (.md)
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => window.print()}>
              <Printer />
              Print / Save as PDF
            </Button>
          </div>

          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold">Game plan</h3>
            <ul className="list-disc space-y-1 pl-5 text-sm">
              {report.gameplan.map((item, index) => (
                <li key={index}>{item}</li>
              ))}
            </ul>
          </div>

          {report.characterStrategy && (
            <div className="flex flex-col gap-2">
              <h3 className="text-sm font-semibold">Character strategy</h3>
              <div className="flex flex-col gap-2 text-sm">
                {report.characterStrategy.picks.length > 0 && (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-muted-foreground">Picks:</span>
                    {report.characterStrategy.picks.map((character) => (
                      <Badge key={character} variant="success">
                        {character}
                      </Badge>
                    ))}
                  </div>
                )}
                <p className="text-muted-foreground">{report.characterStrategy.reasoning}</p>
              </div>
            </div>
          )}

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

      <div className="print-packet-root hidden print:block">
        <h1 className="text-2xl font-bold">
          Scout Report: {record.player.gamerTag} — {new Date(record.createdAt).toLocaleDateString()}
        </h1>

        <h2 className="mt-4 text-lg font-semibold">Overview</h2>
        <p>{report.overview}</p>

        <h2 className="mt-4 text-lg font-semibold">Game plan</h2>
        <ul>
          {report.gameplan.map((item, index) => (
            <li key={index}>{item}</li>
          ))}
        </ul>

        {report.characterStrategy && (
          <>
            <h2 className="mt-4 text-lg font-semibold">Character strategy</h2>
            {report.characterStrategy.picks.length > 0 && (
              <p>Picks: {report.characterStrategy.picks.join(', ')}</p>
            )}
            <p>{report.characterStrategy.reasoning}</p>
          </>
        )}

        <h2 className="mt-4 text-lg font-semibold">Stage strategy</h2>
        {report.stageStrategy.bans.length > 0 && (
          <p>Bans: {report.stageStrategy.bans.join(', ')}</p>
        )}
        {report.stageStrategy.picks.length > 0 && (
          <p>Picks: {report.stageStrategy.picks.join(', ')}</p>
        )}
        <p>{report.stageStrategy.reasoning}</p>

        {report.headToHead && (
          <>
            <h2 className="mt-4 text-lg font-semibold">Head-to-head</h2>
            <p>{report.headToHead}</p>
          </>
        )}

        <h2 className="mt-4 text-lg font-semibold">Watch for</h2>
        <ul>
          {report.watchFor.map((item, index) => (
            <li key={index}>{item}</li>
          ))}
        </ul>

        <h2 className="mt-4 text-lg font-semibold">Confidence notes</h2>
        <p>{report.confidenceNotes}</p>
      </div>
    </>
  );
}
