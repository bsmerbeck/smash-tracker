import type { ScoutReportRecord } from '@smash-tracker/shared';

/**
 * V7-B.1: "Download (.md)" support — a pure content builder for turning a
 * stored `ScoutReportRecord` into clean Markdown, consumed by
 * `ScoutAiReportCard`'s download button. Kept free of DOM/Blob concerns so
 * it's trivially unit-testable (same pattern as `evidencePacket.ts`'s
 * `packetToText`).
 *
 * `report.characterStrategy` is optional on the stored-record schema (V7-B.1
 * back-compat — see packages/shared/src/reports.ts): a pre-B.1 record simply
 * omits that section from the Markdown rather than rendering an empty one.
 */
export function reportToMarkdown(record: ScoutReportRecord): string {
  const { player, report, createdAt } = record;
  const generatedDate = new Date(createdAt).toLocaleDateString();

  const lines: string[] = [];
  lines.push(`# Scout Report: ${player.gamerTag} — ${generatedDate}`);
  lines.push('');

  lines.push('## Overview');
  lines.push(report.overview);
  lines.push('');

  lines.push('## Game plan');
  for (const item of report.gameplan) {
    lines.push(`- ${item}`);
  }
  lines.push('');

  if (report.characterStrategy) {
    lines.push('## Character strategy');
    if (report.characterStrategy.picks.length > 0) {
      lines.push(`Picks: ${report.characterStrategy.picks.join(', ')}`);
      lines.push('');
    }
    lines.push(report.characterStrategy.reasoning);
    lines.push('');
  }

  lines.push('## Stage strategy');
  if (report.stageStrategy.bans.length > 0) {
    lines.push(`Bans: ${report.stageStrategy.bans.join(', ')}`);
  }
  if (report.stageStrategy.picks.length > 0) {
    lines.push(`Picks: ${report.stageStrategy.picks.join(', ')}`);
  }
  lines.push('');
  lines.push(report.stageStrategy.reasoning);
  lines.push('');

  if (report.headToHead) {
    lines.push('## Head-to-head');
    lines.push(report.headToHead);
    lines.push('');
  }

  lines.push('## Watch for');
  for (const item of report.watchFor) {
    lines.push(`- ${item}`);
  }
  lines.push('');

  lines.push('## Confidence notes');
  lines.push(report.confidenceNotes);

  return lines.join('\n');
}

/**
 * Filename for the downloaded Markdown file: `scout-report-<gamerTag>-<YYYY-MM-DD>.md`.
 * The gamer tag is slugified (lowercased, non-alphanumerics collapsed to a
 * single hyphen) so tags with spaces/punctuation still produce a safe
 * filename across operating systems.
 */
export function reportMarkdownFilename(record: ScoutReportRecord): string {
  const slug = record.player.gamerTag
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const isoDate = new Date(record.createdAt).toISOString().slice(0, 10);
  return `scout-report-${slug}-${isoDate}.md`;
}
