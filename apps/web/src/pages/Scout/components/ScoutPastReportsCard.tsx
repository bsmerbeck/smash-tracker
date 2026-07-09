import { useTranslation } from 'react-i18next';
import { History } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import type { ScoutReportRecord } from '@smash-tracker/shared';

/**
 * Recent AI-generated reports (V7-B), newest first. Visible only when AI
 * reports are enabled AND the list is non-empty (both checks happen in
 * `ScoutPage`) — clicking a past report re-renders it in the same
 * `ScoutAiReportCard` used for a freshly generated one, without navigating
 * to a new page.
 */
export function ScoutPastReportsCard({
  reports,
  onSelect,
}: {
  reports: ScoutReportRecord[];
  onSelect: (report: ScoutReportRecord) => void;
}) {
  const { t, i18n } = useTranslation();
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <History className="size-4" />
          {t('scout.pastReports.title')}
        </CardTitle>
        <CardDescription>{t('scout.pastReports.description')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-1">
        {reports.map((record) => (
          <Button
            key={record.id}
            type="button"
            variant="ghost"
            onClick={() => onSelect(record)}
            className="h-auto justify-between px-2 py-2 font-normal"
          >
            <span className="font-medium">{record.player.gamerTag}</span>
            <span className="text-xs text-muted-foreground">
              {new Date(record.createdAt).toLocaleDateString(i18n.language)}
            </span>
          </Button>
        ))}
      </CardContent>
    </Card>
  );
}
