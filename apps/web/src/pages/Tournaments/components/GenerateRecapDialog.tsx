import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Check, Copy } from 'lucide-react';
import { MAX_SHARES_PER_USER } from '@smash-tracker/shared';
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
import { Switch } from '@/components/ui/switch';
import { useAuth } from '@/hooks/useAuth';
import { useCreateVodShare } from '@/hooks/useVodShares';
import { ApiError } from '@/lib/api';

const COPY_FEEDBACK_MS = 2000;

type RecapStep = 'create' | 'created';

/**
 * Phase 7 (RECAP-01/02): owner recap-generation dialog for the Tournament
 * detail page. Modeled on Phase 5's `ShareDialog` (same two-step create ->
 * created shape, same copy-to-clipboard UX), but simplified for a recap:
 * there's no redaction toggle set (a recap only ever carries deterministic
 * tournament stats — see `buildRecapSnapshot`), just the single
 * Show-display-name Switch, and it DEFAULTS ON (07-CONTEXT.md: an anonymous
 * achievement card is meaningless, unlike a VOD review which defaults OFF).
 * "Generate recap" always creates a fresh snapshot+token — regenerating
 * never updates a previously issued link in place.
 *
 * Walkthrough amendment (07-09): a second Switch, "Full recap", DEFAULTS ON
 * — it controls the `detail: 'summary' | 'full'` sent to the create call.
 * "Full" stores (and later renders) the whole set-by-set timeline; opponent
 * tags/placements/stages are public bracket data, not private notes, so the
 * helper text explains that plainly rather than framing it as a privacy
 * trade-off.
 */
export function GenerateRecapDialog({
  entryKey,
  open,
  onOpenChange,
}: {
  entryKey: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const createShare = useCreateVodShare();
  const [step, setStep] = useState<RecapStep>('create');
  const [showDisplayName, setShowDisplayName] = useState(true);
  const [fullRecap, setFullRecap] = useState(true);
  const [createdUrl, setCreatedUrl] = useState('');
  const [copied, setCopied] = useState(false);

  // The server only attaches a name when one actually exists. Without a
  // display name the toggle would silently no-op, so disable it and say why
  // instead of letting the owner believe a name will show on the card.
  const hasDisplayName = Boolean(user?.displayName);
  const effectiveShowName = showDisplayName && hasDisplayName;

  // Reset must key off the `open` PROP (not Radix's onOpenChange, which
  // never fires when the parent flips a controlled prop) — same
  // render-time state adjustment ShareDialog uses, so re-opening for a
  // different tournament never shows a stale created-step link.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setStep('create');
      setShowDisplayName(true);
      setFullRecap(true);
      setCreatedUrl('');
      setCopied(false);
    }
  }

  function handleOpenChange(next: boolean) {
    onOpenChange(next);
  }

  async function handleGenerate() {
    try {
      const result = await createShare.mutateAsync({
        kind: 'recap',
        entryKey,
        detail: fullRecap ? 'full' : 'summary',
        // Recap links are always view-tier (the shared schema 400s an
        // edit-tier recap); stated explicitly since `CreateShareInput` is
        // the schema's OUTPUT type, where the `.default('view')` makes the
        // field required at call sites.
        permissions: 'view',
        ...(effectiveShowName && user?.displayName ? { ownerDisplayName: user.displayName } : {}),
      });
      setCreatedUrl(result.url);
      setStep('created');
    } catch (error) {
      if (error instanceof ApiError && error.status === 403) {
        toast.error(t('tournaments.recap.limitReached', { max: MAX_SHARES_PER_USER }));
      } else {
        toast.error(t('tournaments.recap.generateFailedToast'));
      }
    }
  }

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(createdUrl);
      setCopied(true);
      toast.success(t('tournaments.recap.copiedToast'));
      setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
    } catch {
      // Clipboard access can fail (permissions, insecure context) — the url
      // stays visible/selectable in the read-only Input as the fallback.
      toast.error(t('tournaments.recap.copyFailedToast'));
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-lg">
        {step === 'create' ? (
          <>
            <DialogHeader>
              <DialogTitle>{t('tournaments.recap.dialogTitle')}</DialogTitle>
              <DialogDescription>{t('tournaments.recap.dialogDescription')}</DialogDescription>
            </DialogHeader>

            <div className="flex flex-col gap-4">
              <div className="flex items-center justify-between gap-4">
                <div className="flex flex-col gap-0.5">
                  <Label htmlFor="recap-show-display-name">
                    {t('tournaments.recap.showDisplayNameLabel')}
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    {hasDisplayName
                      ? t('tournaments.recap.showDisplayNameHelper')
                      : t('tournaments.recap.showDisplayNameUnavailable')}
                  </p>
                </div>
                <Switch
                  id="recap-show-display-name"
                  checked={effectiveShowName}
                  onCheckedChange={setShowDisplayName}
                  disabled={!hasDisplayName}
                />
              </div>

              <div className="flex items-center justify-between gap-4">
                <div className="flex flex-col gap-0.5">
                  <Label htmlFor="recap-full-detail">{t('tournaments.recap.fullRecapLabel')}</Label>
                  <p className="text-xs text-muted-foreground">
                    {t('tournaments.recap.fullRecapHelper')}
                  </p>
                </div>
                <Switch id="recap-full-detail" checked={fullRecap} onCheckedChange={setFullRecap} />
              </div>

              <p className="text-xs text-muted-foreground">
                {t('tournaments.recap.regenerateHint')}
              </p>
            </div>

            <DialogFooter className="mt-4">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                {t('common.cancel')}
              </Button>
              <Button type="button" onClick={handleGenerate} disabled={createShare.isPending}>
                {t('tournaments.recap.submitButton')}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>{t('tournaments.recap.createdTitle')}</DialogTitle>
              <DialogDescription>{t('tournaments.recap.createdBody')}</DialogDescription>
            </DialogHeader>

            <div className="flex items-center gap-2">
              <Input
                readOnly
                value={createdUrl}
                aria-label={t('tournaments.recap.createdTitle')}
                onFocus={(event) => event.currentTarget.select()}
              />
              <Button type="button" onClick={handleCopy}>
                {copied ? <Check /> : <Copy />}
                {copied ? t('tournaments.recap.copiedButton') : t('tournaments.recap.copyButton')}
              </Button>
            </div>

            <DialogFooter className="mt-4">
              <Button type="button" onClick={() => onOpenChange(false)}>
                {t('tournaments.recap.doneButton')}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
