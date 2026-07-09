import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { toast } from 'sonner';
import { Check, Copy, RefreshCw, Unlink } from 'lucide-react';
import type { ParryggSearchResult, ParryggSyncSummary } from '@smash-tracker/shared';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  useParryggLink,
  useParryggSearch,
  useParryggStatus,
  useParryggSync,
  useParryggUnlink,
  useParryggVerifyComplete,
  useParryggVerifyStart,
} from '@/hooks/useParrygg';

/** Mirrors start.gg's `describeSummary` in IntegrationsPage.tsx — same shape of "imported X, skipped Y" toast copy. */
function describeSummary(summary: ParryggSyncSummary, t: TFunction): string {
  const skipped =
    summary.dqOrIncomplete +
    summary.otherGame +
    summary.unknownGame +
    summary.teamEntrants +
    summary.unmappedCharacters +
    summary.setsWithoutGameData;
  const parts = [
    t('integrations.summary.importedFromMatches', {
      imported: summary.imported,
      matches: summary.matches,
    }),
  ];
  if (skipped > 0) {
    parts.push(t('integrations.summary.skippedDetail', { count: skipped }));
  }
  if (summary.unmappedStages > 0) {
    parts.push(t('integrations.summary.unknownStages', { count: summary.unmappedStages }));
  }
  return parts.join(' · ');
}

function SearchAndLink({ onLinked }: { onLinked: () => void }) {
  const { t } = useTranslation();
  const [tag, setTag] = useState('');
  const { data: candidates, isFetching } = useParryggSearch(tag);
  const link = useParryggLink();

  async function handleLink(candidate: ParryggSearchResult) {
    try {
      await link.mutateAsync({ parryUserId: candidate.id });
      toast.success(t('integrations.parrygg.linkedTo', { tag: candidate.gamerTag }));
      onLinked();
    } catch {
      toast.error(t('integrations.parrygg.linkFailed'));
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <Input
        placeholder={t('integrations.parrygg.searchPlaceholder')}
        value={tag}
        onChange={(e) => setTag(e.target.value)}
        aria-label={t('integrations.parrygg.searchAria')}
      />
      {tag.trim().length > 0 && (
        <div className="flex flex-col divide-y rounded-md border">
          {isFetching ? (
            <p className="p-3 text-sm text-muted-foreground">
              {t('integrations.parrygg.searching')}
            </p>
          ) : candidates && candidates.length > 0 ? (
            candidates.map((candidate) => (
              <div key={candidate.id} className="flex items-center justify-between gap-2 p-2">
                <div className="flex items-center gap-2">
                  <Avatar size="sm">
                    <AvatarImage src={candidate.avatarUrl} alt="" />
                    <AvatarFallback>{candidate.gamerTag.slice(0, 2).toUpperCase()}</AvatarFallback>
                  </Avatar>
                  <div className="flex flex-col">
                    <span className="text-sm font-medium">{candidate.gamerTag}</span>
                    {(candidate.sponsorName || candidate.locationCountry) && (
                      <span className="text-xs text-muted-foreground">
                        {[candidate.sponsorName, candidate.locationCountry]
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                    )}
                  </div>
                </div>
                <Button
                  type="button"
                  size="sm"
                  onClick={() => handleLink(candidate)}
                  disabled={link.isPending}
                >
                  {t('integrations.parrygg.link')}
                </Button>
              </div>
            ))
          ) : (
            <p className="p-3 text-sm text-muted-foreground">
              {t('integrations.parrygg.noAccounts')}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function VerifyDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const verifyStart = useParryggVerifyStart();
  const verifyComplete = useParryggVerifyComplete();
  const [copied, setCopied] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);

  const code = verifyStart.data?.code;

  // Fires whenever the dialog transitions to open (parent-controlled via
  // the "Verify" button, not just Radix-internal close interactions) —
  // starts/resumes verification so the code is ready as soon as it's shown.
  useEffect(() => {
    if (open && !verifyStart.data && !verifyStart.isPending) {
      verifyStart.mutate(undefined, {
        onError: () => toast.error(t('integrations.parrygg.verifyStartFailed')),
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- verifyStart is a fresh mutation object every render; keying on `open` alone is intentional
  }, [open]);

  function handleOpenChange(next: boolean) {
    if (!next) {
      setCheckError(null);
    }
    onOpenChange(next);
  }

  async function handleCopy() {
    if (!code) {
      return;
    }
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  async function handleCheck() {
    setCheckError(null);
    try {
      await verifyComplete.mutateAsync();
      toast.success(t('integrations.parrygg.verifiedToast'));
      onOpenChange(false);
    } catch (err) {
      setCheckError(err instanceof Error ? err.message : t('integrations.parrygg.codeNotFound'));
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('integrations.parrygg.verifyTitle')}</DialogTitle>
          <DialogDescription>{t('integrations.parrygg.verifyDescription')}</DialogDescription>
        </DialogHeader>

        {code ? (
          <div className="flex items-center gap-2">
            <code className="flex-1 rounded bg-muted px-3 py-2 text-center font-mono text-lg tracking-wider">
              {code}
            </code>
            <Button
              type="button"
              variant="outline"
              size="icon"
              onClick={handleCopy}
              aria-label={t('integrations.parrygg.copyCodeAria')}
            >
              {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
            </Button>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            {t('integrations.parrygg.generatingCode')}
          </p>
        )}

        {checkError && <p className="text-sm text-destructive">{checkError}</p>}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button type="button" onClick={handleCheck} disabled={!code || verifyComplete.isPending}>
            {verifyComplete.isPending
              ? t('integrations.parrygg.checking')
              : t('integrations.parrygg.check')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Settings > Integrations: link a parry.gg account, verify ownership, and sync tournament matches. */
export function ParryggCard() {
  const { t, i18n } = useTranslation();
  const { data: status, isLoading } = useParryggStatus();
  const sync = useParryggSync();
  const unlink = useParryggUnlink();
  const [confirmUnlink, setConfirmUnlink] = useState(false);
  const [verifyOpen, setVerifyOpen] = useState(false);
  const [lastSummary, setLastSummary] = useState<ParryggSyncSummary | null>(null);

  const handleSync = async () => {
    try {
      const summary = await sync.mutateAsync();
      setLastSummary(summary);
      toast.success(describeSummary(summary, t));
    } catch {
      toast.error(t('integrations.syncFailed'));
    }
  };

  const handleUnlink = async () => {
    setConfirmUnlink(false);
    try {
      await unlink.mutateAsync();
      setLastSummary(null);
      toast.success(t('integrations.unlinkedToast', { provider: 'parry.gg' }));
    } catch {
      toast.error(t('integrations.unlinkFailed'));
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>parry.gg</CardTitle>
          {status?.linked && (
            <Badge variant={status.verified ? 'success' : 'outline'}>
              {status.verified
                ? t('integrations.parrygg.verified')
                : t('integrations.parrygg.unverified')}
            </Badge>
          )}
        </div>
        <CardDescription>
          {t('integrations.linkDescription', { provider: 'parry.gg' })}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">{t('integrations.checkingStatus')}</p>
        ) : status?.linked ? (
          <>
            <dl className="grid grid-cols-2 gap-2 text-sm">
              <dt className="text-muted-foreground">{t('integrations.gamerTag')}</dt>
              <dd className="font-medium">{status.gamerTag}</dd>
              <dt className="text-muted-foreground">{t('integrations.lastSynced')}</dt>
              <dd>
                {status.lastSyncAt
                  ? new Date(status.lastSyncAt).toLocaleString(i18n.language)
                  : t('integrations.never')}
              </dd>
            </dl>
            {lastSummary && (
              <p className="text-sm text-muted-foreground">{describeSummary(lastSummary, t)}</p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button onClick={handleSync} disabled={sync.isPending}>
                <RefreshCw className={sync.isPending ? 'animate-spin' : ''} />
                {sync.isPending ? t('integrations.syncing') : t('integrations.syncNow')}
              </Button>
              {!status.verified && (
                <Button variant="outline" onClick={() => setVerifyOpen(true)}>
                  {t('integrations.parrygg.verify')}
                </Button>
              )}
              <Button
                variant="outline"
                onClick={() => setConfirmUnlink(true)}
                disabled={unlink.isPending}
              >
                <Unlink />
                {t('integrations.unlink')}
              </Button>
            </div>
          </>
        ) : (
          <SearchAndLink onLinked={() => setLastSummary(null)} />
        )}
      </CardContent>

      <VerifyDialog open={verifyOpen} onOpenChange={setVerifyOpen} />

      <AlertDialog open={confirmUnlink} onOpenChange={(open) => !open && setConfirmUnlink(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('integrations.unlinkTitle', { provider: 'parry.gg' })}
            </AlertDialogTitle>
            <AlertDialogDescription>{t('integrations.unlinkDescription')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={handleUnlink}>{t('integrations.unlink')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
