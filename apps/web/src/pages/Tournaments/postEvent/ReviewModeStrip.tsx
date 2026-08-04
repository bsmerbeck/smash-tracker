import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';

/**
 * The non-card row directly under `TournamentHeader` on the post-event
 * review surface (28-UI-SPEC.md §1): a `Badge variant="secondary"` naming
 * the mode plus a muted sentence stating what changed. Deliberately
 * lightweight — no banner, no primary color, no icon — the strip's job is
 * naming the mode, not alarming (the event's past date is already visible
 * on the reused `TournamentHeader`).
 */
export function ReviewModeStrip() {
  const { t } = useTranslation();

  return (
    <div className="flex items-center gap-2">
      <Badge variant="secondary">{t('postEvent.mode.badge')}</Badge>
      <span className="text-sm text-muted-foreground">{t('postEvent.mode.sentence')}</span>
    </div>
  );
}
