import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
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

function describeSummary(summary: StartggSyncSummary): string {
  const skipped =
    summary.setsWithoutGames + summary.gamesUnmappedCharacter + summary.gamesMissingSelections;
  const parts = [`Imported ${summary.imported} games from ${summary.sets} sets`];
  if (skipped > 0) {
    parts.push(`${skipped} without importable detail`);
  }
  if (summary.gamesUnknownStage > 0) {
    parts.push(`${summary.gamesUnknownStage} with unrecognized stages`);
  }
  return parts.join(' · ');
}

/** Settings > Integrations: link a start.gg account and sync tournament matches. */
export function IntegrationsPage() {
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
      toast.success('start.gg account linked!');
    } else {
      toast.error(`start.gg linking failed (${searchParams.get('reason') ?? 'unknown error'})`);
    }
    setSearchParams({}, { replace: true });
  }, [searchParams, setSearchParams]);

  const handleSync = async () => {
    try {
      const summary = await sync.mutateAsync();
      setLastSummary(summary);
      toast.success(describeSummary(summary));
    } catch {
      toast.error('Sync failed. Please try again.');
    }
  };

  const handleUnlink = async () => {
    setConfirmUnlink(false);
    try {
      await unlink.mutateAsync();
      setLastSummary(null);
      toast.success('start.gg account unlinked.');
    } catch {
      toast.error('Failed to unlink. Please try again.');
    }
  };

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">Integrations</h1>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>start.gg</CardTitle>
            {status?.linked && <Badge variant="success">Connected</Badge>}
          </div>
          <CardDescription>
            Link your start.gg account to automatically import your Smash Ultimate tournament
            matches. Imported games join your match pool with a competitive tag.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Checking link status…</p>
          ) : status?.linked ? (
            <>
              <dl className="grid grid-cols-2 gap-2 text-sm">
                <dt className="text-muted-foreground">Gamer tag</dt>
                <dd className="font-medium">{status.gamerTag}</dd>
                <dt className="text-muted-foreground">Last synced</dt>
                <dd>
                  {status.lastSyncAt ? new Date(status.lastSyncAt).toLocaleString() : 'Never'}
                </dd>
              </dl>
              {lastSummary && (
                <p className="text-sm text-muted-foreground">{describeSummary(lastSummary)}</p>
              )}
              <div className="flex flex-wrap gap-2">
                <Button onClick={handleSync} disabled={sync.isPending}>
                  <RefreshCw className={sync.isPending ? 'animate-spin' : ''} />
                  {sync.isPending ? 'Syncing…' : 'Sync now'}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => setConfirmUnlink(true)}
                  disabled={unlink.isPending}
                >
                  <Unlink />
                  Unlink
                </Button>
              </div>
            </>
          ) : (
            <div>
              <Button onClick={() => connect.mutate()} disabled={connect.isPending}>
                Connect start.gg account
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <AlertDialog open={confirmUnlink} onOpenChange={(open) => !open && setConfirmUnlink(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Unlink start.gg?</AlertDialogTitle>
            <AlertDialogDescription>
              Already-imported matches stay in your history; new tournament results just stop
              syncing until you reconnect.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleUnlink}>Unlink</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
