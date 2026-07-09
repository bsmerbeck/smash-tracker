import { useMemo, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight, Sparkles } from 'lucide-react';
import { scoutIdentityKey, type ScoutReportRecord } from '@smash-tracker/shared';
import { useReportsConfig, useScoutReportsList } from '@/hooks/useScoutReports';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ScoutAiReportCard } from '@/pages/Scout/components/ScoutAiReportCard';

interface ReportGroup {
  key: string;
  gamerTag: string;
  source: 'startgg' | 'parrygg';
  /** Newest-first, mirroring GET /api/reports' own ordering. */
  reports: ScoutReportRecord[];
}

function sourceLabel(source: 'startgg' | 'parrygg'): string {
  return source === 'parrygg' ? 'parry.gg' : 'start.gg';
}

/** Groups reports by scouted-player identity (source-aware, V9-B), newest report first within each group, groups ordered by their own most-recent report. */
function groupReports(reports: ScoutReportRecord[]): ReportGroup[] {
  const byKey = new Map<string, ReportGroup>();
  for (const record of reports) {
    const key = scoutIdentityKey(record.player);
    const existing = byKey.get(key);
    if (existing) {
      existing.reports.push(record);
    } else {
      byKey.set(key, {
        key,
        gamerTag: record.player.gamerTag,
        source: record.player.source ?? 'startgg',
        reports: [record],
      });
    }
  }
  // Each group's reports are already newest-first (GET /api/reports'
  // ordering is preserved by insertion order here); groups themselves sort
  // by their own newest report, most recent group first.
  return [...byKey.values()].sort(
    (a, b) => (b.reports[0]?.createdAt ?? 0) - (a.reports[0]?.createdAt ?? 0),
  );
}

function ReportGroupRow({
  group,
  selectedId,
  onSelect,
}: {
  group: ReportGroup;
  selectedId: string | null;
  onSelect: (record: ScoutReportRecord) => void;
}) {
  const { t, i18n } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const newest = group.reports[0];
  if (!newest) {
    return null;
  }

  return (
    <div className="flex flex-col gap-1 border-b pb-3 last:border-b-0 last:pb-0">
      <div className="flex items-center justify-between gap-2">
        <Button
          type="button"
          variant="ghost"
          className="h-auto flex-1 justify-start gap-2 px-2 py-2 font-normal"
          onClick={() => onSelect(newest)}
        >
          <span className="font-medium">{group.gamerTag}</span>
          <span className="text-xs text-muted-foreground">{sourceLabel(group.source)}</span>
          <span className="ml-auto text-xs text-muted-foreground">
            {new Date(newest.createdAt).toLocaleDateString(i18n.language)}
          </span>
        </Button>
        {group.reports.length > 1 && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-8 shrink-0"
            onClick={() => setExpanded((v) => !v)}
            aria-label={expanded ? t('reports.hideOlder') : t('reports.showOlder')}
            aria-expanded={expanded}
          >
            {expanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
          </Button>
        )}
      </div>
      {expanded && group.reports.length > 1 && (
        <ul className="ml-4 flex flex-col gap-1 border-l pl-3">
          {group.reports.slice(1).map((record) => (
            <li key={record.id}>
              <Button
                type="button"
                variant="ghost"
                className="h-auto w-full justify-between px-2 py-1.5 font-normal"
                onClick={() => onSelect(record)}
              >
                <span className="text-sm text-muted-foreground">{t('reports.olderReport')}</span>
                <span className="text-xs text-muted-foreground">
                  {new Date(record.createdAt).toLocaleDateString(i18n.language)}
                </span>
              </Button>
            </li>
          ))}
        </ul>
      )}
      {selectedId && group.reports.some((r) => r.id === selectedId) && (
        <div className="mt-2">
          <ScoutAiReportCard record={group.reports.find((r) => r.id === selectedId)!} />
        </div>
      )}
    </div>
  );
}

/**
 * `/reports` — "AI Reports": every stored AI scouting report the signed-in
 * user has generated (V7-B's `GET /api/reports`), grouped by scouted player
 * (source-aware, V9-B — a start.gg player and a parry.gg player never
 * collide even if their numeric-looking ids happen to coincide, see
 * `scoutIdentityKey`), newest report first within a group, groups ordered by
 * their own most recent report.
 *
 * Clicking a row expands the full report inline using `ScoutAiReportCard`
 * (the same component the Scout page uses — download/print come for free).
 * When AI reports aren't enabled for this account at all, shows a friendly
 * note instead of an empty list (distinct from "enabled but nothing
 * generated yet", which shows the ordinary empty state).
 */
export function ReportsPage() {
  const { t } = useTranslation();
  const reportsConfig = useReportsConfig();
  const reportsList = useScoutReportsList();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const groups = useMemo(() => groupReports(reportsList.data ?? []), [reportsList.data]);

  const enabled = reportsConfig.data?.enabled ?? false;

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <div className="flex items-center gap-2">
        <Sparkles className="size-6 text-primary" />
        <h1 className="text-2xl font-semibold tracking-tight">{t('reports.title')}</h1>
      </div>

      {reportsConfig.isSuccess && !enabled && (
        <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          {t('reports.notEnabled')}
        </div>
      )}

      {enabled && (
        <>
          {reportsList.isLoading && (
            <p className="text-sm text-muted-foreground">{t('reports.loading')}</p>
          )}

          {reportsList.isSuccess && groups.length === 0 && (
            <div className="rounded-lg border border-dashed p-16 text-center text-sm text-muted-foreground">
              <Trans
                i18nKey="reports.empty"
                components={{ scoutLink: <a href="/scout" className="underline" /> }}
              />
            </div>
          )}

          {groups.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>{t('reports.yourReports')}</CardTitle>
                <CardDescription>{t('reports.groupedBy')}</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                {groups.map((group) => (
                  <ReportGroupRow
                    key={group.key}
                    group={group}
                    selectedId={selectedId}
                    // Accordion semantics: clicking an already-open report
                    // collapses it instead of being a no-op.
                    onSelect={(record) =>
                      setSelectedId((prev) => (prev === record.id ? null : record.id))
                    }
                  />
                ))}
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
