import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Check, Copy } from 'lucide-react';
import { MAX_SHARES_PER_USER, type Match } from '@smash-tracker/shared';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useAuth } from '@/hooks/useAuth';
import { useCreateVodShare, useVodShares } from '@/hooks/useVodShares';
import { ApiError } from '@/lib/api';

const COPY_FEEDBACK_MS = 2000;

type ShareStep = 'create' | 'created';

/**
 * Owner share-creation dialog (SHARE-01/02/03). Two steps: `'create'` — the
 * redaction toggles (notes/tags/display name) plus a live "Viewers will see"
 * summary — and `'created'` — the returned share url with a one-click copy
 * button. Mirrors `VodNotesDialog`'s overall Dialog shape (header/body/
 * footer, `max-w-lg`). Opened from `SelectedMatchMeta`'s header "Share"
 * button, which is itself disabled when `match.vodUrl` is absent — a
 * VOD-less match can never reach this dialog, so no vodUrl guard is needed
 * here.
 */
export function ShareDialog({
  match,
  open,
  onOpenChange,
}: {
  match: Match;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const createShare = useCreateVodShare();
  const sharesQuery = useVodShares();
  const [step, setStep] = useState<ShareStep>('create');
  const [includeNotes, setIncludeNotes] = useState(true);
  const [includeTags, setIncludeTags] = useState(true);
  const [showDisplayName, setShowDisplayName] = useState(false);
  const [createdUrl, setCreatedUrl] = useState('');
  const [copied, setCopied] = useState(false);

  const hasActiveShare = (sharesQuery.data ?? []).some(
    (share) => share.matchId === match.id && share.status === 'active',
  );

  function handleOpenChange(next: boolean) {
    onOpenChange(next);
    if (next) {
      setStep('create');
      setIncludeNotes(true);
      setIncludeTags(true);
      setShowDisplayName(false);
      setCreatedUrl('');
      setCopied(false);
    }
  }

  async function handleCreate() {
    try {
      const result = await createShare.mutateAsync({
        matchId: match.id,
        redaction: { includeNotes, includeTags, showDisplayName },
        ...(showDisplayName && user?.displayName ? { ownerDisplayName: user.displayName } : {}),
      });
      setCreatedUrl(result.url);
      setStep('created');
    } catch (error) {
      if (error instanceof ApiError && error.status === 403) {
        toast.error(t('vodManager.shares.limitReached', { max: MAX_SHARES_PER_USER }));
      } else {
        toast.error(t('shared.vod.saveFailed'));
      }
    }
  }

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(createdUrl);
      setCopied(true);
      toast.success(t('vodManager.shares.copiedToast'));
      setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
    } catch {
      // Clipboard access can fail (permissions, insecure context) — the url
      // stays visible/selectable in the read-only Input as the fallback.
      toast.error(t('vodManager.shares.copyFailedToast'));
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-lg">
        {step === 'create' ? (
          <>
            <DialogHeader>
              <DialogTitle>{t('vodManager.shares.title')}</DialogTitle>
              <DialogDescription>{t('vodManager.shares.description')}</DialogDescription>
            </DialogHeader>

            <div className="flex flex-col gap-4">
              {hasActiveShare && (
                <p className="text-sm text-muted-foreground">
                  {t('vodManager.shares.reshareHint')}
                </p>
              )}

              <div className="flex items-center justify-between gap-4">
                <div className="flex flex-col gap-0.5">
                  <Label htmlFor="share-include-notes">
                    {t('vodManager.shares.includeNotesLabel')}
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    {t('vodManager.shares.includeNotesHelper')}
                  </p>
                </div>
                <Switch
                  id="share-include-notes"
                  checked={includeNotes}
                  onCheckedChange={setIncludeNotes}
                />
              </div>

              <div className="flex items-center justify-between gap-4">
                <div className="flex flex-col gap-0.5">
                  <Label htmlFor="share-include-tags">
                    {t('vodManager.shares.includeTagsLabel')}
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    {t('vodManager.shares.includeTagsHelper')}
                  </p>
                </div>
                <Switch
                  id="share-include-tags"
                  checked={includeTags}
                  onCheckedChange={setIncludeTags}
                />
              </div>

              <div className="flex items-center justify-between gap-4">
                <div className="flex flex-col gap-0.5">
                  <Label htmlFor="share-show-display-name">
                    {t('vodManager.shares.showDisplayNameLabel')}
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    {t('vodManager.shares.showDisplayNameHelper')}
                  </p>
                </div>
                <Switch
                  id="share-show-display-name"
                  checked={showDisplayName}
                  onCheckedChange={setShowDisplayName}
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <p className="text-xs text-muted-foreground">
                  {t('vodManager.shares.summaryHeading')}
                </p>
                <div
                  className="flex flex-wrap gap-1"
                  aria-label={t('vodManager.shares.summaryHeading')}
                >
                  <Badge variant="secondary">{t('vodManager.shares.summaryMatchResult')}</Badge>
                  <Badge variant="secondary">{t('vodManager.shares.summaryCharacters')}</Badge>
                  <Badge variant="secondary">{t('vodManager.shares.summaryStage')}</Badge>
                  {includeNotes && (
                    <Badge variant="secondary">{t('vodManager.shares.summaryNotes')}</Badge>
                  )}
                  {includeTags && (
                    <Badge variant="secondary">{t('vodManager.shares.summaryTags')}</Badge>
                  )}
                  {showDisplayName && (
                    <Badge variant="secondary">{t('vodManager.shares.summaryName')}</Badge>
                  )}
                </div>
              </div>
            </div>

            <DialogFooter className="mt-4">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                {t('common.cancel')}
              </Button>
              <Button type="button" onClick={handleCreate} disabled={createShare.isPending}>
                {t('vodManager.shares.createButton')}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>{t('vodManager.shares.createdTitle')}</DialogTitle>
              <DialogDescription>{t('vodManager.shares.createdBody')}</DialogDescription>
            </DialogHeader>

            <div className="flex items-center gap-2">
              <Input
                readOnly
                value={createdUrl}
                aria-label={t('vodManager.shares.createdTitle')}
                onFocus={(event) => event.currentTarget.select()}
              />
              <Button type="button" onClick={handleCopy}>
                {copied ? <Check /> : <Copy />}
                {copied ? t('vodManager.shares.copiedButton') : t('vodManager.shares.copyButton')}
              </Button>
            </div>

            <DialogFooter className="mt-4">
              <Button type="button" onClick={() => onOpenChange(false)}>
                {t('vodManager.shares.doneButton')}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
