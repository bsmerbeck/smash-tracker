import { useTranslation } from 'react-i18next';
import { PREP_CHECKLIST_ITEM_IDS, type PrepPresenceMap } from '@smash-tracker/shared';
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { useTogglePrepChecklistItem } from '@/hooks/usePrepBrief';

export interface PrepChecklistCardProps {
  /** The tournament entry this brief belongs to — passed through to the toggle mutation. */
  entryKey: string;
  /** Presence map of checked checklist item ids (D-19) — absent key = unchecked. */
  checklist: PrepPresenceMap;
}

/**
 * The fixed curated 7-item prep checklist (D-21). Always iterates
 * `PREP_CHECKLIST_ITEM_IDS` — never the stored map — so the full curated
 * list renders in the locked order even if `checklist` is empty or
 * (defensively) carries an unexpected key. The machine ID doubles as both
 * the RTDB presence key and the i18n leaf key (`prep.checklist.items.<id>`,
 * D-19), which is what keeps a translated label from ever becoming a
 * storage key.
 */
export function PrepChecklistCard({ entryKey, checklist }: PrepChecklistCardProps) {
  const { t } = useTranslation();
  const toggleItem = useTogglePrepChecklistItem(entryKey);

  const checked = PREP_CHECKLIST_ITEM_IDS.filter((itemId) => Boolean(checklist[itemId])).length;
  const total = PREP_CHECKLIST_ITEM_IDS.length;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('prep.checklist.title')}</CardTitle>
        <CardAction className="text-xs text-muted-foreground">
          {t('prep.checklist.progress', { checked, total })}
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {PREP_CHECKLIST_ITEM_IDS.map((itemId) => {
          const isChecked = Boolean(checklist[itemId]);
          const domId = `prep-checklist-${entryKey}-${itemId}`;
          const isRowPending = toggleItem.isPending && toggleItem.variables?.itemId === itemId;
          return (
            <div key={itemId} className="flex items-center gap-2">
              <Checkbox
                id={domId}
                checked={isChecked}
                disabled={isRowPending}
                onCheckedChange={(next) => toggleItem.mutate({ itemId, checked: next === true })}
              />
              <Label htmlFor={domId}>{t(`prep.checklist.items.${itemId}`)}</Label>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
