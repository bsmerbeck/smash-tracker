import { useState } from 'react';
import { Users } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { useGroupLeaderboard, useGroups } from '@/hooks/useGroups';
import { CreateGroupDialog } from './components/CreateGroupDialog';
import { JoinGroupDialog } from './components/JoinGroupDialog';
import { GroupCardList } from './components/GroupCardList';
import { GroupLeaderboardHeader } from './components/GroupLeaderboardHeader';
import { GroupLeaderboardTable } from './components/GroupLeaderboardTable';
import { describeGroupsError } from './describeGroupsError';

/**
 * `/groups` — V7-D friend-group Glicko-2 leaderboards. Lists the caller's
 * groups as cards; selecting one loads and renders its leaderboard (every
 * member's rating/RD/games/last-active, computed server-side from their own
 * match history — see `apps/api/src/groups/groups.ts`). Create/join are
 * dialogs; leave/delete live in the leaderboard header behind a confirm
 * dialog.
 */
export function GroupsPage() {
  const { user } = useAuth();
  const groups = useGroups();
  // Tracks an explicit user selection only; if it no longer refers to a
  // group in the list (e.g. deleted, or we just left it), nothing is shown
  // instead — derived during render (like OpponentsPage's `selected`), no
  // effect needed to reset state from data that just loaded.
  const [requestedGroupId, setRequestedGroupId] = useState<string | null>(null);

  const myGroups = groups.data ?? [];
  const selectedGroupId =
    requestedGroupId && myGroups.some((g) => g.id === requestedGroupId) ? requestedGroupId : null;

  const leaderboard = useGroupLeaderboard(selectedGroupId);

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Groups</h1>
        <div className="flex gap-2">
          <JoinGroupDialog onJoined={(groupId) => setRequestedGroupId(groupId)} />
          <CreateGroupDialog onCreated={(groupId) => setRequestedGroupId(groupId)} />
        </div>
      </div>

      {groups.isLoading && <div className="text-muted-foreground">Loading your groups...</div>}

      {!groups.isLoading && myGroups.length === 0 && (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed p-16 text-center">
          <Users className="size-8 text-muted-foreground" />
          <h2 className="text-lg font-semibold">No groups yet</h2>
          <p className="max-w-sm text-sm text-muted-foreground">
            Create a group to start a friend-group leaderboard, or join one with an invite code.
          </p>
        </div>
      )}

      {myGroups.length > 0 && (
        <GroupCardList
          groups={myGroups}
          selectedGroupId={selectedGroupId}
          onSelect={setRequestedGroupId}
        />
      )}

      {selectedGroupId && (
        <div className="flex flex-col gap-4 rounded-lg border p-4">
          {leaderboard.isLoading && (
            <div className="text-muted-foreground">Loading leaderboard...</div>
          )}

          {leaderboard.isError && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
              {describeGroupsError(
                leaderboard.error,
                'Something went wrong loading this leaderboard.',
              )}
            </div>
          )}

          {leaderboard.data && (
            <>
              <GroupLeaderboardHeader
                group={leaderboard.data.group}
                isOwner={leaderboard.data.group.ownerUid === user?.uid}
                onLeft={() => setRequestedGroupId(null)}
                onDeleted={() => setRequestedGroupId(null)}
              />
              <GroupLeaderboardTable entries={leaderboard.data.entries} />
            </>
          )}
        </div>
      )}
    </div>
  );
}
