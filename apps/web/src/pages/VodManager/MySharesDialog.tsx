import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { BulkShareAction } from '@smash-tracker/shared';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useBulkVodShares, useVodShares } from '@/hooks/useVodShares';
import { ShareRow } from './components/ShareRow';

/**
 * "My shares" manage list (SHARE-05) — opened from the VOD Manager toolbar
 * button beside the page `<h1>`. Mirrors `VodNotesDialog`'s scroll/overflow
 * shape (`max-h-[90vh] overflow-y-auto`) for a query-driven list of
 * `ShareRow`s, one per active or revoked share.
 *
 * FB-03 walkthrough amendment: adds a selection mode (per-row checkbox +
 * select-all + a live count) driving bulk Revoke / bulk Delete. Both bulk
 * actions open ONE dialog-level `AlertDialog` (not per-row) that summarizes
 * the count for that action, then fire `useBulkVodShares` exactly once — one
 * round-trip, one list invalidation — never a per-id loop.
 */
export function MySharesDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const sharesQuery = useVodShares();
  const bulkVodShares = useBulkVodShares();
  const shares = sharesQuery.data ?? [];

  const [selectionMode, setSelectionMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  /** Which bulk confirm is open — also doubles as the dialog's open state. */
  const [pendingBulkAction, setPendingBulkAction] = useState<BulkShareAction | null>(null);

  function exitSelectionMode() {
    setSelectionMode(false);
    setSelected(new Set());
  }

  function toggleSelected(shareId: string, next: boolean) {
    setSelected((prev) => {
      const nextSet = new Set(prev);
      if (next) {
        nextSet.add(shareId);
      } else {
        nextSet.delete(shareId);
      }
      return nextSet;
    });
  }

  function toggleSelectAll(next: boolean) {
    setSelected(next ? new Set(shares.map((share) => share.shareId)) : new Set());
  }

  async function confirmBulkAction() {
    const action = pendingBulkAction;
    if (!action || selected.size === 0) {
      setPendingBulkAction(null);
      return;
    }
    const shareIds = Array.from(selected);
    try {
      // ONE mutation call for the whole selection — never a per-id loop.
      // The hook's onSuccess invalidates vodSharesQueryKey exactly once.
      await bulkVodShares.mutateAsync({ action, shareIds });
      toast.success(t('vodManager.shares.bulkDoneToast', { count: shareIds.length }));
      exitSelectionMode();
    } catch {
      toast.error(t('shared.vod.saveFailed'));
    }
    setPendingBulkAction(null);
  }

  const bulkDialogTitleKey =
    pendingBulkAction === 'delete'
      ? 'vodManager.shares.bulkDeleteConfirmTitle'
      : 'vodManager.shares.bulkRevokeConfirmTitle';
  const bulkDialogDescriptionKey =
    pendingBulkAction === 'delete'
      ? 'vodManager.shares.bulkDeleteConfirmDescription'
      : 'vodManager.shares.bulkRevokeConfirmDescription';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('vodManager.shares.mySharesTitle')}</DialogTitle>
          <DialogDescription>{t('vodManager.shares.mySharesDescription')}</DialogDescription>
        </DialogHeader>

        {sharesQuery.isLoading ? (
          <p className="text-sm text-muted-foreground">{t('vodManager.shares.loadingShares')}</p>
        ) : shares.length === 0 ? (
          <div className="flex flex-col gap-1">
            <p className="text-sm font-medium">{t('vodManager.shares.emptyTitle')}</p>
            <p className="text-sm text-muted-foreground">{t('vodManager.shares.emptyBody')}</p>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => (selectionMode ? exitSelectionMode() : setSelectionMode(true))}
              >
                {selectionMode
                  ? t('vodManager.shares.selectModeCancel')
                  : t('vodManager.shares.selectModeEnter')}
              </Button>
              {selectionMode && (
                <>
                  <label className="flex items-center gap-1 text-sm">
                    <input
                      type="checkbox"
                      aria-label={t('vodManager.shares.selectAll')}
                      checked={shares.length > 0 && selected.size === shares.length}
                      onChange={(event) => toggleSelectAll(event.target.checked)}
                    />
                    {t('vodManager.shares.selectAll')}
                  </label>
                  <span className="text-sm text-muted-foreground">
                    {t('vodManager.shares.selectionCount', { count: selected.size })}
                  </span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={selected.size === 0}
                    onClick={() => setPendingBulkAction('revoke')}
                  >
                    {t('vodManager.shares.bulkRevoke')}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={selected.size === 0}
                    onClick={() => setPendingBulkAction('delete')}
                  >
                    {t('vodManager.shares.bulkDelete')}
                  </Button>
                </>
              )}
            </div>

            <ul className="flex flex-col gap-2" aria-label={t('vodManager.shares.mySharesTitle')}>
              {shares.map((share) => (
                <li key={share.shareId}>
                  <ShareRow
                    share={share}
                    selectionMode={selectionMode}
                    selected={selected.has(share.shareId)}
                    onToggleSelected={(next) => toggleSelected(share.shareId, next)}
                  />
                </li>
              ))}
            </ul>
          </>
        )}
      </DialogContent>

      <AlertDialog
        open={pendingBulkAction !== null}
        onOpenChange={(next) => {
          if (!next) setPendingBulkAction(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t(bulkDialogTitleKey)}</AlertDialogTitle>
            <AlertDialogDescription>
              {t(bulkDialogDescriptionKey, { count: selected.size })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            {/*
              Reuses the existing per-row confirm-action copy ("Revoke link" /
              "Remove") rather than the toolbar trigger's short "Revoke" /
              "Delete" label — keeps the confirm button's text distinct from
              the trigger button that's still visible underneath.
            */}
            <AlertDialogAction onClick={confirmBulkAction} disabled={bulkVodShares.isPending}>
              {pendingBulkAction === 'delete'
                ? t('vodManager.shares.deleteConfirmAction')
                : t('vodManager.shares.revokeConfirmAction')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  );
}
