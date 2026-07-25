import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { toast } from 'sonner';
import { Check, Copy, KeyRound } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { formatClaimCodeForDisplay } from '@/lib/claimCodeFormat';
import {
  useClaimInvitationStatus,
  useIssueClaimInvitation,
  useRevokeClaimInvitation,
} from '@/hooks/useClaimInvitations';
import { ApiError } from '@/lib/api';

const COPY_FEEDBACK_MS = 2000;

type IssueStep = 'create' | 'created';

/** Structural subset of `ClientHubRow` both call sites can supply. */
export interface IssueClaimCodeDialogClient {
  clientId: string;
  label: string;
}

function describeIssueError(t: TFunction, error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 429) {
      return t('coaching.claimCode.errorRateLimited');
    }
    if (error.status === 503) {
      return t('coaching.claimCode.errorUnavailable');
    }
  }
  return t('coaching.claimCode.errorGeneric');
}

/**
 * Phase 24 (Coach Issuance & Client Claim Experience, ENTRY-02): the coach's
 * copy-once claim-code issuance dialog. Forked from
 * `apps/web/src/pages/VodManager/ShareDialog.tsx`'s two-step
 * `'create' | 'created'` machine and its render-time `wasOpen`
 * prop-transition reset (mirrored below, not an effect) — the parent
 * controls `open`, and re-opening this dialog never fires `onOpenChange`.
 *
 * SECURITY (threat register T-24-15/T-24-16/T-24-17): the raw code minted by
 * `useIssueClaimInvitation` lives in exactly one `useState` for the lifetime
 * of this component and nowhere else. It is never persisted to any browser
 * storage or written anywhere durable, never appended to a URL or query
 * string, never handed to a router navigation, and never passed to a
 * logging or analytics call — this component holds the ONLY copy that ever
 * exists client-side. The display field is `readOnly` (never a masked
 * credential input) so a form-fill manager can neither type into nor save
 * it. Because the API returns the raw code exactly once (Phase 23 contract)
 * and it can never be re-shown, closing the dialog from the created step
 * requires an explicit confirmation — it can only be re-generated
 * afterward, not recovered.
 */
export function IssueClaimCodeDialog({
  client,
  open,
  onOpenChange,
}: {
  client: IssueClaimCodeDialogClient;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const statusQuery = useClaimInvitationStatus(client.clientId);
  const issueInvitation = useIssueClaimInvitation();
  const revokeInvitation = useRevokeClaimInvitation();

  const [step, setStep] = useState<IssueStep>('create');
  const [createdCode, setCreatedCode] = useState('');
  const [createdExpiresAt, setCreatedExpiresAt] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmingClose, setConfirmingClose] = useState(false);
  const [confirmingRevoke, setConfirmingRevoke] = useState(false);

  // Render-time reset on the `open` PROP transition (mirrors
  // ShareDialog.tsx:88-100) rather than an effect — resetting only inside
  // onOpenChange would leave this dialog stuck on a stale 'created' step
  // (and a stale code) the next time it's opened, since the parent never
  // fires onOpenChange when it flips `open` back to true.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setStep('create');
      setCreatedCode('');
      setCreatedExpiresAt(null);
      setCopied(false);
      setConfirmingClose(false);
      setConfirmingRevoke(false);
    }
  }

  function requestClose() {
    if (step === 'created') {
      setConfirmingClose(true);
      return;
    }
    onOpenChange(false);
  }

  function confirmClose() {
    setConfirmingClose(false);
    onOpenChange(false);
  }

  function cancelClose() {
    setConfirmingClose(false);
  }

  async function handleGenerate() {
    try {
      const result = await issueInvitation.mutateAsync(client.clientId);
      setCreatedCode(result.code);
      setCreatedExpiresAt(result.expiresAt);
      setStep('created');
    } catch (error) {
      toast.error(describeIssueError(t, error));
    }
  }

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(displayCode);
      setCopied(true);
      toast.success(t('coaching.claimCode.copiedToast'));
      setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
    } catch {
      // Clipboard access can fail (permissions, insecure context) — the code
      // stays visible/selectable in the read-only Input as the fallback.
      toast.error(t('coaching.claimCode.copyFailedToast'));
    }
  }

  async function handleRevoke() {
    try {
      await revokeInvitation.mutateAsync(client.clientId);
      toast.success(t('coaching.claimCode.revokedToast'));
      setConfirmingRevoke(false);
    } catch {
      toast.error(t('coaching.claimCode.revokeError'));
    }
  }

  const outstanding = statusQuery.data?.outstanding ?? false;
  const displayCode = formatClaimCodeForDisplay(createdCode);

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : requestClose())}>
      <DialogContent className="max-w-lg">
        {step === 'create' && (
          <>
            <DialogHeader>
              <DialogTitle>{t('coaching.claimCode.title')}</DialogTitle>
              <DialogDescription>{t('coaching.claimCode.description')}</DialogDescription>
            </DialogHeader>

            <div className="flex flex-col gap-3">
              <p className="text-sm text-muted-foreground">
                {t('coaching.claimCode.rotationWarning')}
              </p>
              <p className="text-sm text-muted-foreground">
                {outstanding
                  ? t('coaching.claimCode.statusOutstanding')
                  : t('coaching.claimCode.statusNone')}
              </p>

              {outstanding && (
                <div className="flex flex-col gap-2 rounded-md border border-destructive/30 p-3">
                  {confirmingRevoke ? (
                    <div className="flex flex-col gap-2">
                      <p className="text-sm">{t('coaching.claimCode.revokeConfirmBody')}</p>
                      <div className="flex justify-end gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => setConfirmingRevoke(false)}
                        >
                          {t('coaching.claimCode.revokeConfirmCancel')}
                        </Button>
                        <Button
                          type="button"
                          variant="destructive"
                          size="sm"
                          onClick={handleRevoke}
                          disabled={revokeInvitation.isPending}
                        >
                          {t('coaching.claimCode.revokeConfirmAction')}
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="w-fit text-destructive hover:text-destructive"
                      onClick={() => setConfirmingRevoke(true)}
                    >
                      {t('coaching.claimCode.revokeTrigger')}
                    </Button>
                  )}
                </div>
              )}
            </div>

            <DialogFooter className="mt-4">
              <Button type="button" variant="outline" onClick={requestClose}>
                {t('common.cancel')}
              </Button>
              <Button type="button" onClick={handleGenerate} disabled={issueInvitation.isPending}>
                <KeyRound />
                {issueInvitation.isPending
                  ? t('coaching.claimCode.generatingButton')
                  : t('coaching.claimCode.generateButton')}
              </Button>
            </DialogFooter>
          </>
        )}

        {step === 'created' && !confirmingClose && (
          <>
            <DialogHeader>
              <DialogTitle>{t('coaching.claimCode.title')}</DialogTitle>
            </DialogHeader>

            <div className="flex flex-col gap-3">
              <div className="flex items-end gap-2">
                <div className="flex flex-1 flex-col gap-1.5">
                  <Label htmlFor="claim-code-field">{t('coaching.claimCode.codeFieldLabel')}</Label>
                  <Input
                    id="claim-code-field"
                    readOnly
                    value={displayCode}
                    onFocus={(event) => event.currentTarget.select()}
                  />
                </div>
                <Button type="button" onClick={handleCopy}>
                  {copied ? <Check /> : <Copy />}
                  {copied
                    ? t('coaching.claimCode.copiedButton')
                    : t('coaching.claimCode.copyButton')}
                </Button>
              </div>

              {createdExpiresAt != null && (
                <p className="text-sm text-muted-foreground">
                  {t('coaching.claimCode.expiresAt', {
                    date: new Date(createdExpiresAt).toLocaleString(),
                  })}
                </p>
              )}

              <p className="text-sm text-muted-foreground">
                {t('coaching.claimCode.handoffInstructions')}
              </p>
              <p className="text-sm font-medium text-destructive">
                {t('coaching.claimCode.onceWarning')}
              </p>
            </div>

            <DialogFooter className="mt-4">
              <Button type="button" onClick={requestClose}>
                {t('coaching.claimCode.doneButton')}
              </Button>
            </DialogFooter>
          </>
        )}

        {step === 'created' && confirmingClose && (
          <>
            <DialogHeader>
              <DialogTitle>{t('coaching.claimCode.closeConfirmTitle')}</DialogTitle>
              <DialogDescription>{t('coaching.claimCode.closeConfirmBody')}</DialogDescription>
            </DialogHeader>
            <DialogFooter className="mt-4">
              <Button type="button" variant="outline" onClick={cancelClose}>
                {t('coaching.claimCode.closeConfirmCancel')}
              </Button>
              <Button type="button" variant="destructive" onClick={confirmClose}>
                {t('coaching.claimCode.closeConfirmAction')}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
