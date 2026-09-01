import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { ReviewListItem } from '@/lib/api';
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
import { Label } from '@/components/ui/label';

export interface DeleteReviewDialogProps {
  /** The review pending deletion, or `null` to keep the dialog closed. */
  review: ReviewListItem | null;
  /** How many delivery links this review has — the copy must state they stop working. */
  deliveryCount: number;
  onOpenChange: (open: boolean) => void;
  onConfirm: (review: ReviewListItem) => void;
  isPending: boolean;
}

/**
 * Quick 260901-f7a: irreversible hard-delete confirmation for ONE archived
 * review, cloned structurally from `DeleteWorkspaceDialog`
 * (`apps/web/src/pages/ClientWorkspace/`) rather than forking a divergent
 * confirm pattern.
 *
 * CONFIRM-WORD DECISION. `DeleteWorkspaceDialog` and `DeleteClientDialog`
 * both make the user type the object's own LABEL. Reviews are UNTITLED:
 * `ReviewsListPage`'s `reviewRowLabel` renders
 * `t('coaching.reviews.list.rowLabel', { date: ... .toLocaleDateString() })`
 * — a locale- and timezone-formatted string containing an em dash, and two
 * reviews started on the same day render identically. That is not a usable
 * typed-confirm target, so per the locked design's untitled fallback this
 * dialog displays and expects a FIXED word: the literal `DELETE`, kept
 * byte-identical across all six locale files (untranslated, the same
 * convention CONVENTIONS.md applies to provider names). A translated
 * confirm word would push a Japanese or Portuguese user through an
 * IME/accent detour just to retype a string the dialog is showing them
 * verbatim.
 *
 * The server-side archived-only guard (`deleteReview`'s `ConflictError`) is
 * independent of this dialog — this is a second, human-facing lock, never
 * the only one.
 */
export function DeleteReviewDialog({
  review,
  deliveryCount,
  onOpenChange,
  onConfirm,
  isPending,
}: DeleteReviewDialogProps) {
  const { t } = useTranslation();
  const [typed, setTyped] = useState('');
  const confirmWord = t('coaching.reviews.list.deleteDialog.confirmWord');

  function handleOpenChange(next: boolean) {
    onOpenChange(next);
    if (!next) {
      setTyped('');
    }
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!review || typed !== confirmWord) {
      return;
    }
    onConfirm(review);
  }

  // Exact equality, no trim — mirrors `DeleteWorkspaceDialog` exactly.
  const matches = review != null && typed === confirmWord;

  return (
    <Dialog open={review != null} onOpenChange={handleOpenChange}>
      <DialogContent>
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{t('coaching.reviews.list.deleteDialog.title')}</DialogTitle>
            <DialogDescription>
              {t('coaching.reviews.list.deleteDialog.description', { count: deliveryCount })}
              <br />
              {t('common.cannotBeUndone')}
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-2 py-4">
            <Label htmlFor="coaching-review-delete-confirm">
              {t('coaching.reviews.list.deleteDialog.confirmLabel', { word: confirmWord })}
            </Label>
            <Input
              id="coaching-review-delete-confirm"
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              placeholder={confirmWord}
              autoFocus
              autoComplete="off"
            />
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" variant="destructive" disabled={!matches || isPending}>
              {isPending
                ? t('coaching.reviews.list.deleteDialog.pending')
                : t('coaching.reviews.list.deleteDialog.confirm')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
