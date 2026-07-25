import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { OwnedWorkspace } from '@smash-tracker/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useRevokeCoachDelegation } from '@/hooks/useClientWorkspaces';
import { describeCoachingError } from '@/pages/Coaching/describeCoachingError';

/**
 * Phase 24 (Coach Issuance & Client Claim Experience, CTRL-02): the claimed
 * workspace's "Coach access" card. Revoke calls Phase 23's
 * `DELETE /api/client-workspaces/:tenantId/delegations/:delegateUid`, which
 * emits the `coach_delegation_revoked` canonical event (EVT-03) and cuts
 * access immediately — the coach's very next request 403s, with no cached or
 * lingering access. The list invalidation that clears this card back to its
 * no-access state is wired in `useRevokeCoachDelegation`'s `onSuccess`
 * (Plan 24-03); this component does not add a second invalidation.
 *
 * Confirm pattern mirrors the coach-side claim-code revoke control (a plain
 * inline cancel/confirm swap, not a type-the-name dialog — that stronger
 * discipline is reserved for irreversible hard-deletes elsewhere in this
 * codebase).
 */
export function CoachAccessCard({ workspace }: { workspace: OwnedWorkspace }) {
  const { t } = useTranslation();
  const revoke = useRevokeCoachDelegation();
  const [confirming, setConfirming] = useState(false);

  async function handleConfirmRevoke() {
    if (!workspace.delegateCoachUid) {
      return;
    }
    try {
      await revoke.mutateAsync({
        tenantId: workspace.tenantId,
        delegateUid: workspace.delegateCoachUid,
      });
      toast.success(t('ownerWorkspace.coachAccess.revokedToast'));
      setConfirming(false);
    } catch (error) {
      toast.error(describeCoachingError(error, t('ownerWorkspace.coachAccess.revokeError')));
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('ownerWorkspace.coachAccess.title')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-sm text-muted-foreground">
          {t('ownerWorkspace.coachAccess.description')}
        </p>

        {workspace.delegateCoachUid ? (
          <div className="flex flex-col gap-2">
            <p className="text-sm">
              {t('ownerWorkspace.coachAccess.delegatedCoach', {
                uid: workspace.delegateCoachUid,
              })}
            </p>
            {confirming ? (
              <div className="flex flex-col gap-2 rounded-md border border-destructive/30 p-3">
                <p className="text-sm">{t('ownerWorkspace.coachAccess.revokeConfirmBody')}</p>
                <div className="flex justify-end gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setConfirming(false)}
                  >
                    {t('ownerWorkspace.coachAccess.revokeConfirmCancel')}
                  </Button>
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    onClick={handleConfirmRevoke}
                    disabled={revoke.isPending}
                  >
                    {t('ownerWorkspace.coachAccess.revokeConfirmAction')}
                  </Button>
                </div>
              </div>
            ) : (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="w-fit text-destructive hover:text-destructive"
                onClick={() => setConfirming(true)}
              >
                {t('ownerWorkspace.coachAccess.revokeTrigger')}
              </Button>
            )}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{t('ownerWorkspace.coachAccess.none')}</p>
        )}
      </CardContent>
    </Card>
  );
}
