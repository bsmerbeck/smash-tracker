import { useState } from 'react';
import type { FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { PendingButton } from '@/components/ui/pending-button';
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
import { useCreateCoachingClient } from '@/hooks/useCoachingClients';
import { describeCoachingError } from '../describeCoachingError';

/**
 * "Create a client" dialog: a single label input (1-40 chars), POST
 * /api/coaching/clients on confirm. Mirrors `apps/web/src/pages/Groups/
 * components/CreateGroupDialog.tsx`. On a 409 (duplicate, case-insensitive
 * label), the dialog stays open with the server's message shown inline so
 * the coach can re-prompt with a different label — never silently drops the
 * input.
 */
export function CreateClientDialog({ triggerLabel }: { triggerLabel: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState('');
  const createClient = useCreateCoachingClient();

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) {
      setLabel('');
      createClient.reset();
    }
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmed = label.trim();
    if (!trimmed) {
      return;
    }
    createClient.mutate(
      { label: trimmed },
      {
        onSuccess: (client) => {
          handleOpenChange(false);
          navigate(`/coach/${client.clientId}/vods`);
        },
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button type="button">{triggerLabel}</Button>
      </DialogTrigger>
      <DialogContent>
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{t('coaching.hub.create.title')}</DialogTitle>
            <DialogDescription>{t('coaching.hub.create.description')}</DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-2 py-4">
            <Label htmlFor="coaching-client-label">{t('coaching.hub.create.labelLabel')}</Label>
            <Input
              id="coaching-client-label"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              maxLength={40}
              placeholder={t('coaching.hub.create.labelPlaceholder')}
              autoFocus
            />
          </div>

          {createClient.isError && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
              {describeCoachingError(createClient.error, t('coaching.hub.create.error'))}
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <PendingButton type="submit" pending={createClient.isPending} disabled={!label.trim()}>
              {createClient.isPending
                ? t('coaching.hub.create.pending')
                : t('coaching.hub.create.confirm')}
            </PendingButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
