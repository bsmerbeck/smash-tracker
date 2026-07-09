import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { GspReading } from '@smash-tracker/shared';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useUpdateGspReading } from '@/hooks/useGspReadings';
import { parseGspNumber } from '../lib/parseGspNumber';

/**
 * V17: corrects a standalone "set GSP" calibration reading's value — the
 * counterpart of EditMatchForm for reading entries in the GSP log / curve
 * click-to-edit. Only the value is editable (the API keeps `time` and the
 * fighter fixed; a reading in the wrong place is a delete + re-create).
 * Mount it conditionally (`{editingReading && <EditGspReadingDialog …>}`)
 * so the draft state initializes fresh per reading, same as EditMatchForm.
 */
export function EditGspReadingDialog({
  reading,
  open,
  onOpenChange,
  onDelete,
}: {
  reading: GspReading;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Hands off to the page's shared delete confirmation, mirroring EditMatchForm. */
  onDelete?: (reading: GspReading) => void;
}) {
  const { t } = useTranslation();
  const updateReading = useUpdateGspReading();
  const [draft, setDraft] = useState(String(reading.gsp));

  async function save() {
    const gsp = parseGspNumber(draft);
    if (gsp === null) {
      toast.error(t('gsp.logger.invalidGsp'));
      return;
    }
    try {
      await updateReading.mutateAsync({ id: reading.id, input: { gsp } });
      toast.success(t('gsp.editReading.saved'));
      onOpenChange(false);
    } catch {
      toast.error(t('gsp.editReading.saveFailed'));
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{t('gsp.editReading.title')}</DialogTitle>
          <DialogDescription>{t('gsp.editReading.description')}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium" htmlFor="edit-gsp-reading-value">
            {t('gsp.setGsp.label')}
          </label>
          {/* type="text": browsers reject comma pastes into type="number",
              and GSP is shown with thousands separators in-game. */}
          <Input
            id="edit-gsp-reading-value"
            type="text"
            inputMode="numeric"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            autoFocus
          />
        </div>
        <DialogFooter className="gap-2 sm:justify-between">
          {onDelete && (
            <Button type="button" variant="destructive" onClick={() => onDelete(reading)}>
              {t('common.delete')}
            </Button>
          )}
          <Button type="button" onClick={() => void save()} disabled={updateReading.isPending}>
            {t('common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
