import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { OwnedWorkspace } from '@smash-tracker/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useDeleteOwnedWorkspace } from '@/hooks/useClientWorkspaces';
import { describeCoachingError } from '@/pages/Coaching/describeCoachingError';
import { DeleteWorkspaceDialog } from './DeleteWorkspaceDialog';

/**
 * Quick 260726-r6 (Phase 24 backlog gap, owner request 2026-07-26): the
 * claimed workspace's destructive section — visually separated below
 * `CoachAccessCard`, styled distinctly from every other card on this page.
 * Renders ONLY on `OwnerWorkspaceOverviewPage`, which itself only ever
 * renders for a workspace the current user owns (from
 * `useClientWorkspaces()`) — this card never appears in the coach's own
 * `/coach/:clientId/*` client workspace UI, by construction of which page
 * mounts it, not by a role check inside this component.
 *
 * Deleting reuses the coach side's SAME irreversible cascade
 * (`api.clientWorkspaces.deleteWorkspace` → `DELETE /api/coaching/clients/
 * :tenantId` → `deleteClient`'s `CANONICAL_TENANT_TREES` walk,
 * `apps/api/src/coaching/tenants.ts`). A 403 (e.g. access changed mid-flight
 * — the coach demoted this owner's role between page load and confirm,
 * though today only the owner/custodian role can reach this UI at all) shows
 * an error toast via `describeCoachingError` rather than leaving the button
 * stuck in its pending state.
 */
export function DangerZoneCard({ workspace }: { workspace: OwnedWorkspace }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const deleteWorkspace = useDeleteOwnedWorkspace();
  const [pendingDelete, setPendingDelete] = useState<OwnedWorkspace | null>(null);

  function handleConfirm(target: OwnedWorkspace) {
    deleteWorkspace.mutate(target.tenantId, {
      onSuccess: () => {
        toast.success(t('ownerWorkspace.deleteWorkspace.deletedToast', { label: target.label }));
        setPendingDelete(null);
        navigate('/dashboard');
      },
      onError: (error) => {
        toast.error(describeCoachingError(error, t('ownerWorkspace.deleteWorkspace.error')));
      },
    });
  }

  return (
    <Card className="border-destructive/40">
      <CardHeader>
        <CardTitle className="text-destructive">
          {t('ownerWorkspace.deleteWorkspace.sectionTitle')}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-sm text-muted-foreground">
          {t('ownerWorkspace.deleteWorkspace.sectionDescription')}
        </p>
        <Button
          type="button"
          variant="destructive"
          size="sm"
          className="w-fit"
          onClick={() => setPendingDelete(workspace)}
        >
          {t('ownerWorkspace.deleteWorkspace.trigger')}
        </Button>
      </CardContent>

      <DeleteWorkspaceDialog
        workspace={pendingDelete}
        onOpenChange={(open) => {
          if (!open) {
            setPendingDelete(null);
          }
        }}
        onConfirm={handleConfirm}
        isPending={deleteWorkspace.isPending}
      />
    </Card>
  );
}
