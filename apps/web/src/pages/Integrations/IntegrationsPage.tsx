import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { toast } from 'sonner';
import { RefreshCw, Unlink } from 'lucide-react';
import type { StartggSyncSummary } from '@smash-tracker/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
import { Badge } from '@/components/ui/badge';
import {
  useStartggConnect,
  useStartggStatus,
  useStartggSync,
  useStartggUnlink,
} from '@/hooks/useStartgg';
import { ParryggCard } from './components/ParryggCard';

function describeSummary(summary: StartggSyncSummary, t: TFunction): string {
  const skipped =
    summary.setsWithoutGames + summary.gamesUnmappedCharacter + summary.gamesMissingSelections;
  const parts = [
    t('integrations.summary.importedFromSets', { imported: summary.imported, sets: summary.sets }),
  ];
  if (skipped > 0) {
    parts.push(t('integrations.summary.skippedDetail', { count: skipped }));
  }
  if (summary.gamesUnknownStage > 0) {
    parts.push(t('integrations.summary.unknownStages', { count: summary.gamesUnknownStage }));
  }
  if (summary.dqSets > 0) {
    parts.push(t('integrations.summary.dqSkipped', { count: summary.dqSets }));
  }
  return parts.join(' · ');
}

/** Settings > Integrations: link a start.gg account and sync tournament matches. */
export function IntegrationsPage() {
  const { t, i18n } = useTranslation();
  const { data: status, isLoading } = useStartggStatus();
  const connect = useStartggConnect();
  const sync = useStartggSync();
  const unlink = useStartggUnlink();
  const [confirmUnlink, setConfirmUnlink] = useState(false);
  const [lastSummary, setLastSummary] = useState<StartggSyncSummary | null>(null);

  // Surface the OAuth callback outcome (the API redirects back with a query param).
  const [searchParams, setSearchParams] = useSearchParams();
  const announcedCallback = useRef(false);
  useEffect(() => {
    const outcome = searchParams.get('startgg');
    if (!outcome || announcedCallback.current) {
      return;
    }
    announcedCallback.current = true;
    if (outcome === 'linked') {
      toast.success(t('integrations.startgg.linked'));
    } else {
      toast.error(
        t('integrations.startgg.linkFailed', {
          reason: searchParams.get('reason') ?? t('integrations.startgg.unknownError'),
        }),
      );
    }
    setSearchParams({}, { replace: true });
  }, [searchParams, setSearchParams, t]);

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
      toast.success(t('integrations.unlinkedToast', { provider: 'start.gg' }));
    } catch {
      toast.error(t('integrations.unlinkFailed'));
    }
  };

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">{t('integrations.title')}</h1>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>start.gg</CardTitle>
            {status?.linked && <Badge variant="success">{t('integrations.connected')}</Badge>}
          </div>
          <CardDescription>
            {t('integrations.linkDescription', { provider: 'start.gg' })}
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
            <div>
              <Button onClick={() => connect.mutate()} disabled={connect.isPending}>
                {t('integrations.startgg.connect')}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <AlertDialog open={confirmUnlink} onOpenChange={(open) => !open && setConfirmUnlink(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('integrations.unlinkTitle', { provider: 'start.gg' })}
            </AlertDialogTitle>
            <AlertDialogDescription>{t('integrations.unlinkDescription')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={handleUnlink}>{t('integrations.unlink')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <ParryggCard />
    </div>
  );
}
