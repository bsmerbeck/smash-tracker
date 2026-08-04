import { useTranslation } from 'react-i18next';
import { REVIEW_CHECKLIST_ITEM_IDS, type PrepPresenceMap } from '@smash-tracker/shared';
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { useToggleReviewChecklistItem } from '@/hooks/usePrepBrief';

export interface ReviewChecklistCardProps {
  /** The tournament entry this brief belongs to — passed through to the toggle mutation. */
  entryKey: string;
  /** Presence map of checked review-checklist item ids — absent key = unchecked. */
  reviewChecklist: PrepPresenceMap;
}

/**
 * The free post-event review's annotation checklist (REV-01/REV-02) — a
 * deliberate visual twin of `prep/PrepChecklistCard`: always iterates the
 * fixed `REVIEW_CHECKLIST_ITEM_IDS` tuple (never the stored map, so a stray
 * or stale key in the presence map renders nothing extra), one mutation per
 * toggle, optimistic update, row-pending disable. DOM ids are namespaced
 * `post-event-checklist-${entryKey}-${itemId}` so this checklist can mount
 * on the same page as `PrepChecklistCard` (inside the collapsed prep
 * section, 28-UI-SPEC §1) without any id collision.
 *
 * The server fires `post_event_review_completed` exactly once, server-side,
 * on the first incomplete→complete transition of THIS checklist (owner
 * invariant 4) — this card does nothing special for that: unchecking an
 * item later is an ordinary reversible toggle, and there is no UI
 * celebration state. The progress counter reaching "5/5 complete" is the
 * only confirmation (UI-SPEC recommendation: no confetti, no toast).
 */
export function ReviewChecklistCard({ entryKey, reviewChecklist }: ReviewChecklistCardProps) {
  const { t } = useTranslation();
  const toggleItem = useToggleReviewChecklistItem(entryKey);

  const checked = REVIEW_CHECKLIST_ITEM_IDS.filter((itemId) =>
    Boolean(reviewChecklist[itemId]),
  ).length;
  const total = REVIEW_CHECKLIST_ITEM_IDS.length;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('postEvent.checklist.title')}</CardTitle>
        <CardAction className="text-xs text-muted-foreground">
          {t('postEvent.checklist.progress', { checked, total })}
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {REVIEW_CHECKLIST_ITEM_IDS.map((itemId) => {
          const isChecked = Boolean(reviewChecklist[itemId]);
          const domId = `post-event-checklist-${entryKey}-${itemId}`;
          const isRowPending = toggleItem.isPending && toggleItem.variables?.itemId === itemId;
          return (
            <div key={itemId} className="flex items-center gap-2">
              <Checkbox
                id={domId}
                checked={isChecked}
                disabled={isRowPending}
                onCheckedChange={(next) => toggleItem.mutate({ itemId, checked: next === true })}
              />
              <Label htmlFor={domId}>{t(`postEvent.checklist.items.${itemId}`)}</Label>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
