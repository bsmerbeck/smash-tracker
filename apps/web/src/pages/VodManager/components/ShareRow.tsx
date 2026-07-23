import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Copy, Link2Off, Trash2 } from 'lucide-react';
import type { ShareSummary } from '@smash-tracker/shared';
import { getFighterById } from '@/data/sprites';
import { localizedFighterName } from '@/lib/fighterNames';
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
export function ShareRow({
  share,
  selectionMode = false,
  selected = false,
  onToggleSelected,
}: {
  share: ShareSummary;
  /** FB-03 bulk-select mode, driven by MySharesDialog. */
  selectionMode?: boolean;
  selected?: boolean;
  onToggleSelected?: (next: boolean) => void;
}) {
  const { t } = useTranslation();
  const revokeShare = useRevokeVodShare();
  const deleteShare = useDeleteVodShare();
  const [confirmingRevoke, setConfirmingRevoke] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [confirmingActiveDelete, setConfirmingActiveDelete] = useState(false);

  const isRecap = share.kind === 'recap';
  const fighter = share.fighterId != null ? getFighterById(share.fighterId) : undefined;
  const opponentFighter =
    share.opponentFighterId != null ? getFighterById(share.opponentFighterId) : undefined;
  const isRevoked = share.status === 'revoked';
  /**
   * Review WR-05: an edit-tier link past its 30-day `expiresAt`. The link is
   * dead (identical to revoked on every anonymous path), so the row dims,
   * labels itself, and drops the Copy action — but KEEPS Revoke: revoking an
   * expired share is the path to deleting its row (delete requires revoked).
   */
  const isExpired = share.status === 'expired';
  /** COACH-01: an edit-tier (coaching) link gets a visually distinct badge. */
  const isEdit = share.permissions === 'edit';

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

  /**
   * WR-05/FB-03: an ACTIVE share's Delete now succeeds directly (Plan 02
   * dropped the 409-while-active guard) — no forced revoke-then-delete
   * chain. Reuses the same `useDeleteVodShare` mutation as the revoked-row
   * Delete; only the confirm copy and the dialog-open state differ.
   */
  async function confirmActiveDelete() {
    try {
      await deleteShare.mutateAsync(share.shareId);
      toast.success(t('vodManager.shares.deletedToast'));
    } catch {
      toast.error(t('shared.vod.saveFailed'));
    }
    setConfirmingActiveDelete(false);
  }

  return (
    <div
      className={cn(
        'flex items-center gap-2 rounded-md border p-2 text-sm',
        (isRevoked || isExpired) && 'opacity-60',
      )}
    >
      {selectionMode && (
        <input
          type="checkbox"
          aria-label={t('vodManager.shares.selectRowAria')}
          checked={selected}
          onChange={(event) => onToggleSelected?.(event.target.checked)}
        />
      )}
      <div className="flex flex-1 flex-col items-start gap-1">
        <div className="flex flex-wrap items-center gap-2">
          {isEdit ? (
            // Filled (default) variant — coaching links must read differently
            // from plain view links at a glance in the manage list.
            <Badge>{t('vodManager.shares.permissionEdit')}</Badge>
          ) : (
            <Badge variant="outline">{t('vodManager.shares.permissionView')}</Badge>
          )}
          <span className="font-medium">
            {isRecap
              ? (share.tournamentName ?? t('common.unknown'))
              : `${fighter && share.fighterId != null ? localizedFighterName(share.fighterId, t) : t('common.unknown')} vs ${opponentFighter && share.opponentFighterId != null ? localizedFighterName(share.opponentFighterId, t) : t('common.unknown')}`}
          </span>
          {isRevoked && (
            <span className="text-xs font-medium text-destructive">
              {t('vodManager.shares.revokedStatus')}
            </span>
          )}
          {isExpired && (
            <span className="text-xs font-medium text-muted-foreground">
              {t('vodManager.shares.expiredStatus')}
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
          {share.redaction?.includedNotes && (
            <Badge variant="secondary" className="text-xs">
              {t('vodManager.shares.chipNotes')}
            </Badge>
          )}
          {share.redaction?.includedTags && (
            <Badge variant="secondary" className="text-xs">
              {t('vodManager.shares.chipTags')}
            </Badge>
          )}
          {share.redaction?.showDisplayName && (
            <Badge variant="secondary" className="text-xs">
              {t('vodManager.shares.chipName')}
            </Badge>
          )}
        </div>
      </div>
      {!isRevoked && (
        <>
          {/* WR-05: no Copy for an expired share — the link is dead. */}
          {!isExpired && (
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              aria-label={t('vodManager.shares.copyLinkAria')}
              onClick={handleCopy}
            >
              <Copy />
            </Button>
          )}
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
          {/*
            WR-05/FB-03: Delete is now available on ACTIVE (non-expired) rows
            too — one honest confirm, no forced revoke-then-delete chain. An
            expired-but-not-yet-revoked row keeps only Revoke (the existing
            path to becoming deletable); it does not get this Delete.
          */}
          {!isExpired && (
            <>
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                aria-label={t('vodManager.shares.deleteActiveShareAria')}
                onClick={() => setConfirmingActiveDelete(true)}
              >
                <Trash2 />
              </Button>
              <AlertDialog open={confirmingActiveDelete} onOpenChange={setConfirmingActiveDelete}>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>
                      {t('vodManager.shares.deleteActiveConfirmTitle')}
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                      {t('vodManager.shares.deleteActiveConfirmDescription')}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={confirmActiveDelete}
                      disabled={deleteShare.isPending}
                    >
                      {t('vodManager.shares.deleteConfirmAction')}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </>
          )}
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
