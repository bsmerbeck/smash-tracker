import { ChevronLeft, ChevronRight, History } from 'lucide-react';
import type { ScoutReportRecord } from '@smash-tracker/shared';
import { Button } from '@/components/ui/button';

/**
 * V9-B Feature 1: a compact prev/next selector shown above the AI report
 * card when the scouted player has MULTIPLE stored reports — without it,
 * only the newest report for a player is ever reachable (see
 * `ScoutPage.storedRecordForCurrentPlayer`). `reports` is newest-first (same
 * ordering `GET /api/reports` guarantees); `index` 0 is the newest.
 */
export function ScoutReportHistorySelector({
  reports,
  index,
  onChange,
}: {
  reports: ScoutReportRecord[];
  index: number;
  onChange: (index: number) => void;
}) {
  const total = reports.length;
  const current = reports[index];
  if (!current) {
    return null;
  }

  // Displayed as "Report N of total" where N counts from the OLDEST (so
  // "Report 1" is the first one ever generated) while `index` internally
  // counts from the newest — the ordinal for the current record is simply
  // `total - index`.
  const ordinal = total - index;

  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground">
      <History className="size-4" />
      <Button
        type="button"
        variant="outline"
        size="icon"
        className="size-7"
        disabled={index >= total - 1}
        onClick={() => onChange(index + 1)}
        aria-label="Older report"
      >
        <ChevronLeft className="size-4" />
      </Button>
      <span>
        Report {ordinal} of {total} · {new Date(current.createdAt).toLocaleDateString()}
      </span>
      <Button
        type="button"
        variant="outline"
        size="icon"
        className="size-7"
        disabled={index <= 0}
        onClick={() => onChange(index - 1)}
        aria-label="Newer report"
      >
        <ChevronRight className="size-4" />
      </Button>
    </div>
  );
}
