import { useState } from 'react';
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
                Delete group
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete "{group.name}"?</AlertDialogTitle>
                <AlertDialogDescription>
                  This removes the group and its leaderboard for every member. This can't be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              {deleteGroup.isError && (
                <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
                  {describeGroupsError(
                    deleteGroup.error,
                    'Something went wrong deleting the group.',
                  )}
                </div>
              )}
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => deleteGroup.mutate(group.id, { onSuccess: () => onDeleted?.() })}
                  disabled={deleteGroup.isPending}
                >
                  {deleteGroup.isPending ? 'Deleting...' : 'Delete'}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        ) : (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button type="button" variant="outline" size="sm">
                Leave group
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Leave "{group.name}"?</AlertDialogTitle>
                <AlertDialogDescription>
                  You'll need a new invite code to rejoin later.
                </AlertDialogDescription>
              </AlertDialogHeader>
              {leaveGroup.isError && (
                <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
                  {describeGroupsError(leaveGroup.error, 'Something went wrong leaving the group.')}
                </div>
              )}
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => leaveGroup.mutate(group.id, { onSuccess: () => onLeft?.() })}
                  disabled={leaveGroup.isPending}
                >
                  {leaveGroup.isPending ? 'Leaving...' : 'Leave'}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}
      </div>

      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <span>Invite code:</span>
        <code className="rounded bg-muted px-2 py-0.5 font-mono text-foreground">
          {group.inviteCode}
        </code>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7"
          onClick={handleCopy}
          aria-label="Copy invite code"
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        </Button>
      </div>
    </div>
  );
}
