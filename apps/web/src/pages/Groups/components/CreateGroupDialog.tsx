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
import { useCreateGroup } from '@/hooks/useGroups';
import { describeGroupsError } from '../describeGroupsError';

/** "Create group" dialog: a single name input, POST /api/groups on confirm. */
export function CreateGroupDialog({ onCreated }: { onCreated?: (groupId: string) => void }) {
  const { t } = useTranslation();
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
        <Button type="button">{t('groups.create.trigger')}</Button>
      </DialogTrigger>
      <DialogContent>
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{t('groups.create.title')}</DialogTitle>
            <DialogDescription>{t('groups.create.description')}</DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-2 py-4">
            <Label htmlFor="group-name">{t('groups.create.nameLabel')}</Label>
            <Input
              id="group-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={40}
              placeholder={t('groups.create.namePlaceholder')}
              autoFocus
            />
          </div>

          {createGroup.isError && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
              {describeGroupsError(createGroup.error, t('groups.create.error'))}
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={!name.trim() || createGroup.isPending}>
              {createGroup.isPending ? t('groups.create.pending') : t('groups.create.confirm')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
