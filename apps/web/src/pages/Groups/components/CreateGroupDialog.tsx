import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useCreateGroup } from '@/hooks/useGroups';
import { describeGroupsError } from '../describeGroupsError';

/** "Create group" dialog: a single name input, POST /api/groups on confirm. */
export function CreateGroupDialog({ onCreated }: { onCreated?: (groupId: string) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const createGroup = useCreateGroup();

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) {
      setName('');
      createGroup.reset();
    }
  }

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      return;
    }
    createGroup.mutate(trimmed, {
      onSuccess: (group) => {
        handleOpenChange(false);
        onCreated?.(group.id);
      },
    });
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button type="button">Create group</Button>
      </DialogTrigger>
      <DialogContent>
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Create a group</DialogTitle>
            <DialogDescription>
              Start a friend-group leaderboard. You can invite others with a code once it's created.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-2 py-4">
            <Label htmlFor="group-name">Group name</Label>
            <Input
              id="group-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={40}
              placeholder="e.g. The Locals"
              autoFocus
            />
          </div>

          {createGroup.isError && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
              {describeGroupsError(createGroup.error, 'Something went wrong creating the group.')}
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim() || createGroup.isPending}>
              {createGroup.isPending ? 'Creating...' : 'Create'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
