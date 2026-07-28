import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { OwnedWorkspace } from '@smash-tracker/shared';
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

export interface DeleteWorkspaceDialogProps {
  /** The workspace pending deletion, or `null` to keep the dialog closed. */
  workspace: OwnedWorkspace | null;
  onOpenChange: (open: boolean) => void;
  onConfirm: (workspace: OwnedWorkspace) => void;
  isPending: boolean;
}

/**
 * Quick 260726-r6: irreversible hard-delete confirmation for the OWNER's own
 * claimed workspace — the same type-the-exact-label discipline as the
 * coach-side `DeleteClientDialog` (`apps/web/src/pages/Coaching/components/
 * DeleteClientDialog.tsx`), which this deliberately mirrors rather than
 * forking a divergent confirm pattern. Deleting reuses the SAME
 * `CANONICAL_TENANT_TREES` cascade (`apps/api/src/coaching/tenants.ts`) via
 * `api.clientWorkspaces.deleteWorkspace` — there is no direct-DB repair once
 * confirmed, and the delegated coach's delivered review/session links stop
 * resolving immediately.
 */
export function DeleteWorkspaceDialog({
  workspace,
  onOpenChange,
  onConfirm,
  isPending,
}: DeleteWorkspaceDialogProps) {
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
    if (!workspace || typedLabel !== workspace.label) {
      return;
    }
    onConfirm(workspace);
  }

  const matches = workspace != null && typedLabel === workspace.label;

  return (
    <Dialog open={workspace != null} onOpenChange={handleOpenChange}>
      <DialogContent>
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{t('ownerWorkspace.deleteWorkspace.title')}</DialogTitle>
            <DialogDescription>
              {t('ownerWorkspace.deleteWorkspace.description', {
                label: workspace?.label ?? '',
              })}
              <br />
              {t('common.cannotBeUndone')}
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-2 py-4">
            <Label htmlFor="owner-workspace-delete-confirm">
              {t('ownerWorkspace.deleteWorkspace.confirmLabel', {
                label: workspace?.label ?? '',
              })}
            </Label>
            <Input
              id="owner-workspace-delete-confirm"
              value={typedLabel}
              onChange={(event) => setTypedLabel(event.target.value)}
              placeholder={workspace?.label ?? ''}
              autoFocus
              autoComplete="off"
            />
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" variant="destructive" disabled={!matches || isPending}>
              {isPending
                ? t('ownerWorkspace.deleteWorkspace.pending')
                : t('ownerWorkspace.deleteWorkspace.confirm')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
