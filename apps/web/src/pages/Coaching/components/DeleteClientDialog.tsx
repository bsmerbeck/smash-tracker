import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { ClientHubRow } from '@smash-tracker/shared';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export interface DeleteClientDialogProps {
  /** The client pending deletion, or `null` to keep the dialog closed. */
  client: ClientHubRow | null;
  onOpenChange: (open: boolean) => void;
  onConfirm: (client: ClientHubRow) => void;
  isPending: boolean;
}

/**
 * Irreversible hard-delete confirmation (TEN-06, threat T-11-17): the
 * destructive action only enables once the coach types the client's EXACT
 * label — mirrors the type-the-name discipline requested for accidental
 * hard-delete protection. Deleting cascades every one of the client's trees
 * server-side (`apps/api/src/coaching/tenants.ts`'s `CANONICAL_TENANT_TREES`
 * cascade) — there is no direct-DB repair once confirmed.
 */
export function DeleteClientDialog({
  client,
  onOpenChange,
  onConfirm,
  isPending,
}: DeleteClientDialogProps) {
  const { t } = useTranslation();
  const [typedLabel, setTypedLabel] = useState('');

  function handleOpenChange(next: boolean) {
    onOpenChange(next);
    if (!next) {
      setTypedLabel('');
    }
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!client || typedLabel !== client.label) {
      return;
    }
    onConfirm(client);
  }

  const matches = client != null && typedLabel === client.label;

  return (
    <Dialog open={client != null} onOpenChange={handleOpenChange}>
      <DialogContent>
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{t('coaching.hub.delete.title')}</DialogTitle>
            <DialogDescription>
              {t('coaching.hub.delete.description', { label: client?.label ?? '' })}
              <br />
              {t('common.cannotBeUndone')}
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-2 py-4">
            <Label htmlFor="coaching-client-delete-confirm">
              {t('coaching.hub.delete.confirmLabel', { label: client?.label ?? '' })}
            </Label>
            <Input
              id="coaching-client-delete-confirm"
              value={typedLabel}
              onChange={(event) => setTypedLabel(event.target.value)}
              placeholder={client?.label ?? ''}
              autoFocus
              autoComplete="off"
            />
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" variant="destructive" disabled={!matches || isPending}>
              {isPending ? t('coaching.hub.delete.pending') : t('coaching.hub.delete.confirm')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
