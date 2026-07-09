import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Copy } from 'lucide-react';
import type { GroupRecord } from '@smash-tracker/shared';
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
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { useDeleteGroup, useLeaveGroup } from '@/hooks/useGroups';
import { describeGroupsError } from '../describeGroupsError';

/**
 * Group leaderboard header: name, invite code with a copy button, and a
 * Leave (member) or Delete (owner) action behind a confirm dialog. The
 * owner sees Delete instead of Leave — the API itself also blocks an
 * owner-leave while other members remain (409), but hiding Leave for the
 * owner avoids surfacing that error in the first place when deletion is
 * the only sensible owner action once other members have joined.
 */
export function GroupLeaderboardHeader({
  group,
  isOwner,
  onLeft,
  onDeleted,
}: {
  group: GroupRecord;
  isOwner: boolean;
  onLeft?: () => void;
  onDeleted?: () => void;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const leaveGroup = useLeaveGroup();
  const deleteGroup = useDeleteGroup();

  async function handleCopy() {
    await navigator.clipboard.writeText(group.inviteCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-xl font-semibold tracking-tight">{group.name}</h2>

        {isOwner ? (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button type="button" variant="destructive" size="sm">
                {t('groups.header.deleteTrigger')}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {t('groups.header.deleteTitle', { name: group.name })}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {t('groups.header.deleteDescription')}
                </AlertDialogDescription>
              </AlertDialogHeader>
              {deleteGroup.isError && (
                <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
                  {describeGroupsError(deleteGroup.error, t('groups.header.deleteError'))}
                </div>
              )}
              <AlertDialogFooter>
                <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => deleteGroup.mutate(group.id, { onSuccess: () => onDeleted?.() })}
                  disabled={deleteGroup.isPending}
                >
                  {deleteGroup.isPending ? t('groups.header.deletePending') : t('common.delete')}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        ) : (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button type="button" variant="outline" size="sm">
                {t('groups.header.leaveTrigger')}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {t('groups.header.leaveTitle', { name: group.name })}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {t('groups.header.leaveDescription')}
                </AlertDialogDescription>
              </AlertDialogHeader>
              {leaveGroup.isError && (
                <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
                  {describeGroupsError(leaveGroup.error, t('groups.header.leaveError'))}
                </div>
              )}
              <AlertDialogFooter>
                <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => leaveGroup.mutate(group.id, { onSuccess: () => onLeft?.() })}
                  disabled={leaveGroup.isPending}
                >
                  {leaveGroup.isPending
                    ? t('groups.header.leavePending')
                    : t('groups.header.leaveConfirm')}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}
      </div>

      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <span>{t('groups.header.inviteCode')}</span>
        <code className="rounded bg-muted px-2 py-0.5 font-mono text-foreground">
          {group.inviteCode}
        </code>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7"
          onClick={handleCopy}
          aria-label={t('groups.header.copyAria')}
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        </Button>
      </div>
    </div>
  );
}
