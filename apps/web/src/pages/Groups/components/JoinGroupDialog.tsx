import { useState } from 'react';
import { useTranslation } from 'react-i18next';
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
import { useJoinGroup } from '@/hooks/useGroups';
import { describeGroupsError } from '../describeGroupsError';

/** "Join with code" dialog: an 8-char invite code input, POST /api/groups/join on confirm. */
export function JoinGroupDialog({ onJoined }: { onJoined?: (groupId: string) => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState('');
  const joinGroup = useJoinGroup();

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) {
      setCode('');
      joinGroup.reset();
    }
  }

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = code.trim();
    if (!trimmed) {
      return;
    }
    joinGroup.mutate(trimmed, {
      onSuccess: (group) => {
        handleOpenChange(false);
        onJoined?.(group.id);
      },
    });
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline">
          {t('groups.join.trigger')}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{t('groups.join.title')}</DialogTitle>
            <DialogDescription>{t('groups.join.description')}</DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-2 py-4">
            <Label htmlFor="invite-code">{t('groups.join.codeLabel')}</Label>
            <Input
              id="invite-code"
              value={code}
              onChange={(event) => setCode(event.target.value.toUpperCase())}
              maxLength={8}
              placeholder={t('groups.join.codePlaceholder')}
              className="font-mono uppercase"
              autoFocus
            />
          </div>

          {joinGroup.isError && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
              {describeGroupsError(joinGroup.error, t('groups.join.error'))}
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={!code.trim() || joinGroup.isPending}>
              {joinGroup.isPending ? t('groups.join.pending') : t('groups.join.confirm')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
