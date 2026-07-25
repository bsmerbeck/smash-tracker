import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { CLAIM_CODE_LENGTH } from '@smash-tracker/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  countSignificantClaimCodeChars,
  formatClaimCodeForDisplay,
  normalizeClaimCodeInput,
} from '@/lib/claimCodeFormat';
import { useMatches } from '@/hooks/useMatches';
import { ApiError, api } from '@/lib/api';

type ClaimStep = 'entry' | 'confirm' | 'success';
type CollisionChoice = 'keepBoth' | 'notNow';
type ClaimErrorKey = 'generic' | 'rateLimited' | 'unavailable';

/**
 * `/claim` — the authenticated client-facing claim-code redemption surface
 * (ENTRY-01, CLAIM-01), reached only from `ProtectedRoute` (T-24-32: the code
 * is typed after authentication, so it can never appear in a pre-auth
 * redirect target).
 *
 * SECURITY (owner binding revision, 24-CONTEXT.md Area 2.2, threat register
 * T-24-30): the entered code lives ONLY in this component's `code` state and
 * in the POST body `api.claims.redeem` sends. It is never written to any
 * browser storage, never appended to the URL or a query string, never passed
 * to a router navigation call, never included in an analytics event, and
 * never handed to a logging call. The route itself takes no parameters, so
 * every entry link into this page is bare and a code-bearing deep link
 * cannot exist by construction (T-24-36).
 *
 * There is no preview endpoint by design — the server's no-oracle contract
 * (T-24-31) means this page never reads or renders the server's `message`
 * field. The confirmation step (static copy) always runs BEFORE the redeem
 * call, and every redemption failure other than 429/503 renders one generic
 * message, regardless of cause.
 */
export function ClaimRedeemPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const matchesQuery = useMatches();

  const [step, setStep] = useState<ClaimStep>('entry');
  const [code, setCode] = useState('');
  const [collisionChoice, setCollisionChoice] = useState<CollisionChoice | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [errorKey, setErrorKey] = useState<ClaimErrorKey | null>(null);
  const [claimedTenantId, setClaimedTenantId] = useState<string | null>(null);

  const significantChars = countSignificantClaimCodeChars(code);
  const canContinue = significantChars === CLAIM_CODE_LENGTH;
  const hasPersonalLibrary = (matchesQuery.data?.length ?? 0) > 0;
  // Confirm requires an EXPLICIT choice when a collision exists — either
  // option unblocks it, not just keep-both, so the defer/not-now path can
  // still be confirmed (24-CONTEXT.md Area 3.2: the radio starts unselected
  // and blocks redemption until the user picks one of the two options).
  const canConfirm = hasPersonalLibrary ? collisionChoice !== null : true;

  function handleContinue() {
    setErrorKey(null);
    setStep('confirm');
  }

  function handleBack() {
    setStep('confirm' === step ? 'entry' : step);
  }

  async function handleConfirm() {
    if (hasPersonalLibrary && collisionChoice === 'notNow') {
      // Defer: return to a neutral state, no request issued, nothing changed.
      setStep('entry');
      setCollisionChoice(null);
      return;
    }

    setSubmitting(true);
    setErrorKey(null);
    try {
      const result = await api.claims.redeem(normalizeClaimCodeInput(code));
      setClaimedTenantId(result.tenantId);
      setStep('success');
      toast.success(t('claim.success.toast'));
    } catch (error) {
      if (error instanceof ApiError && error.status === 429) {
        setErrorKey('rateLimited');
      } else if (error instanceof ApiError && error.status === 503) {
        setErrorKey('unavailable');
      } else {
        // Every other outcome, including every 400 shape, maps to the same
        // generic key — the server's own body is never read here.
        setErrorKey('generic');
      }
      setStep('entry');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto flex max-w-lg flex-col gap-6 px-4 py-10">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t('claim.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('claim.subtitle')}</p>
      </div>

      {errorKey && step === 'entry' && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          {t(`claim.error.${errorKey}`)}
        </div>
      )}

      {step === 'entry' && (
        <Card>
          <CardContent className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="claim-code-input">{t('claim.codeLabel')}</Label>
              <Input
                id="claim-code-input"
                autoComplete="off"
                spellCheck={false}
                type="text"
                placeholder={t('claim.codePlaceholder')}
                value={formatClaimCodeForDisplay(code)}
                onChange={(event) => setCode(event.target.value)}
              />
              <p className="text-xs text-muted-foreground">{t('claim.codeHelp')}</p>
            </div>
            <Button type="button" onClick={handleContinue} disabled={!canContinue}>
              {t('claim.continueButton')}
            </Button>
          </CardContent>
        </Card>
      )}

      {step === 'confirm' && (
        <Card>
          <CardHeader>
            <CardTitle>{t('claim.confirm.title')}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <CardDescription>{t('claim.confirm.youGain')}</CardDescription>
            <CardDescription>{t('claim.confirm.coachBecomes')}</CardDescription>
            <p className="text-sm font-medium">{t('claim.confirm.noChangesYet')}</p>

            {hasPersonalLibrary && (
              <div className="flex flex-col gap-2 rounded-md border p-3">
                <p className="text-sm font-medium">{t('claim.collision.title')}</p>
                <p className="text-xs text-muted-foreground">{t('claim.collision.description')}</p>
                <RadioGroup
                  value={collisionChoice ?? undefined}
                  onValueChange={(value) => setCollisionChoice(value as CollisionChoice)}
                  aria-label={t('claim.collision.title')}
                >
                  <div className="flex items-start gap-2">
                    <RadioGroupItem value="keepBoth" id="claim-collision-keep-both" />
                    <Label
                      htmlFor="claim-collision-keep-both"
                      className="flex flex-col items-start gap-0.5 font-normal"
                    >
                      <span>{t('claim.collision.keepBothLabel')}</span>
                      <span className="text-xs text-muted-foreground">
                        {t('claim.collision.keepBothDescription')}
                      </span>
                    </Label>
                  </div>
                  <div className="flex items-start gap-2">
                    <RadioGroupItem value="notNow" id="claim-collision-not-now" />
                    <Label
                      htmlFor="claim-collision-not-now"
                      className="flex flex-col items-start gap-0.5 font-normal"
                    >
                      <span>{t('claim.collision.notNowLabel')}</span>
                      <span className="text-xs text-muted-foreground">
                        {t('claim.collision.notNowDescription')}
                      </span>
                    </Label>
                  </div>
                </RadioGroup>
                {collisionChoice === null && (
                  <p className="text-xs text-muted-foreground">
                    {t('claim.collision.chooseFirst')}
                  </p>
                )}
              </div>
            )}

            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={handleBack} disabled={submitting}>
                {t('claim.confirm.backButton')}
              </Button>
              <Button type="button" onClick={handleConfirm} disabled={!canConfirm || submitting}>
                {submitting
                  ? t('claim.confirm.submittingButton')
                  : t('claim.confirm.confirmButton')}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {step === 'success' && claimedTenantId && (
        <Card>
          <CardHeader>
            <CardTitle>{t('claim.success.title')}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <p className="text-sm">{t('claim.success.whatChanged')}</p>
            <p className="text-sm text-muted-foreground">{t('claim.success.coachNote')}</p>
            <Button
              type="button"
              onClick={() => navigate(`/workspace/${claimedTenantId}/overview`)}
            >
              {t('claim.success.goToWorkspaceButton')}
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
