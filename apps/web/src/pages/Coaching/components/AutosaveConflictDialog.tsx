import { useTranslation } from 'react-i18next';
import type { ReviewDraft, ReviewSection } from '@smash-tracker/shared';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

function sectionsPreview(sections: ReviewSection[]): string {
  const visible = sections.filter((section) => !section.hidden && section.body.trim().length > 0);
  if (visible.length === 0) {
    return '';
  }
  return visible.map((section) => section.body).join('\n\n');
}

export interface AutosaveConflictDialogProps {
  open: boolean;
  /** The coach's current, unsaved local buffer — the "mine" side of the comparison. */
  mine: { sections: ReviewSection[]; coachPrivateNotes: string | null };
  /** The server's current draft, returned by the 409 — the "theirs" side. `null` only if the 409 body was unparseable. */
  serverDraft: ReviewDraft | null;
  /** "Keep mine" — re-submits the local buffer against the server's now-known revision. */
  onKeepMine: () => void;
  /** "See theirs" — discards the local buffer and adopts the server draft. */
  onSeeTheirs: () => void;
}

/**
 * The recoverable 409 conflict dialog (REV-02/D-07, T-12-18): opened the
 * moment `useReviewAutosave` reports `status === 'conflict'`. Offers exactly
 * two EXPLICIT choices — never a silent auto-merge or auto-reload — so a
 * stale write can never clobber newer text written from another tab/device.
 */
export function AutosaveConflictDialog({
  open,
  mine,
  serverDraft,
  onKeepMine,
  onSeeTheirs,
}: AutosaveConflictDialogProps) {
  const { t } = useTranslation();

  const minePreview = sectionsPreview(mine.sections);
  const theirsPreview = serverDraft ? sectionsPreview(serverDraft.sections) : '';

  return (
    <Dialog open={open}>
      <DialogContent showCloseButton={false} onEscapeKeyDown={(event) => event.preventDefault()}>
        <DialogHeader>
          <DialogTitle>{t('coaching.reviews.composer.conflictDialog.title')}</DialogTitle>
          <DialogDescription>
            {t('coaching.reviews.composer.conflictDialog.description')}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-md border p-3">
            <p className="mb-1.5 text-xs font-semibold text-muted-foreground">
              {t('coaching.reviews.composer.conflictDialog.mineLabel')}
            </p>
            <p className="line-clamp-6 whitespace-pre-wrap text-sm">
              {minePreview || t('coaching.reviews.composer.conflictDialog.empty')}
            </p>
          </div>
          <div className="rounded-md border p-3">
            <p className="mb-1.5 text-xs font-semibold text-muted-foreground">
              {t('coaching.reviews.composer.conflictDialog.theirsLabel')}
            </p>
            <p className="line-clamp-6 whitespace-pre-wrap text-sm">
              {theirsPreview || t('coaching.reviews.composer.conflictDialog.empty')}
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onSeeTheirs}>
            {t('coaching.reviews.composer.conflictDialog.seeTheirs')}
          </Button>
          <Button onClick={onKeepMine}>
            {t('coaching.reviews.composer.conflictDialog.keepMine')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
