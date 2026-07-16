import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Copy, Link2Off, Trash2 } from 'lucide-react';
import type { ShareSummary } from '@smash-tracker/shared';
import { getFighterById } from '@/data/sprites';
import { Badge } from '@/components/ui/badge';
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
import { useDeleteVodShare, useRevokeVodShare } from '@/hooks/useVodShares';
import { cn } from '@/lib/utils';

/**
 * One row in the "My shares" manage list (SHARE-05). Modeled on
 * `PlaylistRow`'s "primary content block + sibling icon buttons" layout.
 * Revoke reuses `TimestampRow`'s delete-confirm `AlertDialog` shape with the
 * verbatim honest copy locked in 05-CONTEXT.md (SHARE-04). A revoked row
 * renders at reduced opacity and drops BOTH the copy and revoke actions —
 * no un-revoke; the owner creates a new link instead.
 */
export function ShareRow({ share }: { share: ShareSummary }) {
  const { t } = useTranslation();
  const revokeShare = useRevokeVodShare();
  const deleteShare = useDeleteVodShare();
  const [confirmingRevoke, setConfirmingRevoke] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const fighter = getFighterById(share.fighterId);
  const opponentFighter = getFighterById(share.opponentFighterId);
  const isRevoked = share.status === 'revoked';

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(share.url);
      toast.success(t('vodManager.shares.copiedToast'));
    } catch {
      // Clipboard access can fail (permissions, insecure context) — the
      // link's still readable/copyable from the created step's Input as the
      // fallback, so this is a soft failure, not a blocker.
      toast.error(t('vodManager.shares.copyFailedToast'));
    }
  }

  async function confirmRevoke() {
    try {
      await revokeShare.mutateAsync(share.shareId);
    } catch {
      toast.error(t('shared.vod.saveFailed'));
    }
    setConfirmingRevoke(false);
  }

  async function confirmDelete() {
    try {
      await deleteShare.mutateAsync(share.shareId);
      toast.success(t('vodManager.shares.deletedToast'));
    } catch {
      toast.error(t('shared.vod.saveFailed'));
    }
    setConfirmingDelete(false);
  }

  return (
    <div
      className={cn(
        'flex items-center gap-2 rounded-md border p-2 text-sm',
        isRevoked && 'opacity-60',
      )}
    >
      <div className="flex flex-1 flex-col items-start gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">{t('vodManager.shares.permissionView')}</Badge>
          <span className="font-medium">
            {fighter?.name ?? t('common.unknown')} vs {opponentFighter?.name ?? t('common.unknown')}
          </span>
          {isRevoked && (
            <span className="text-xs font-medium text-destructive">
              {t('vodManager.shares.revokedStatus')}
            </span>
          )}
        </div>
        <span className="text-xs text-muted-foreground">
          {t('vodManager.shares.snapshotDate', {
            // Date AND time: same-day shares are otherwise visually identical.
            date: new Date(share.createdAt).toLocaleString(undefined, {
              dateStyle: 'short',
              timeStyle: 'short',
            }),
          })}
        </span>
        <div className="flex flex-wrap items-center gap-1">
          {share.redaction.includedNotes && (
            <Badge variant="secondary" className="text-xs">
              {t('vodManager.shares.chipNotes')}
            </Badge>
          )}
          {share.redaction.includedTags && (
            <Badge variant="secondary" className="text-xs">
              {t('vodManager.shares.chipTags')}
            </Badge>
          )}
          {share.redaction.showDisplayName && (
            <Badge variant="secondary" className="text-xs">
              {t('vodManager.shares.chipName')}
            </Badge>
          )}
        </div>
      </div>
      {!isRevoked && (
        <>
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            aria-label={t('vodManager.shares.copyLinkAria')}
            onClick={handleCopy}
          >
            <Copy />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            aria-label={t('vodManager.shares.revokeLinkAria')}
            onClick={() => setConfirmingRevoke(true)}
          >
            {/* Link2Off (kill the link) — deliberately distinct from the
                revoked row's Trash2 (delete the row) so the two destructive
                actions read differently at a glance. */}
            <Link2Off />
          </Button>
          <AlertDialog open={confirmingRevoke} onOpenChange={setConfirmingRevoke}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{t('vodManager.shares.revokeConfirmTitle')}</AlertDialogTitle>
                <AlertDialogDescription>
                  {t('vodManager.shares.revokeConfirmDescription')}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
                <AlertDialogAction onClick={confirmRevoke} disabled={revokeShare.isPending}>
                  {t('vodManager.shares.revokeConfirmAction')}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </>
      )}
      {isRevoked && (
        <>
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            aria-label={t('vodManager.shares.deleteShareAria')}
            onClick={() => setConfirmingDelete(true)}
          >
            <Trash2 />
          </Button>
          <AlertDialog open={confirmingDelete} onOpenChange={setConfirmingDelete}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{t('vodManager.shares.deleteConfirmTitle')}</AlertDialogTitle>
                <AlertDialogDescription>
                  {t('vodManager.shares.deleteConfirmDescription')}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
                <AlertDialogAction onClick={confirmDelete} disabled={deleteShare.isPending}>
                  {t('vodManager.shares.deleteConfirmAction')}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </>
      )}
    </div>
  );
}
