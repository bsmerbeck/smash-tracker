import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { toast } from 'sonner';
import { MoreHorizontal, Plus } from 'lucide-react';
import type { SessionDeliveryListItem, SessionResponse } from '@/lib/api';
import {
  useCoachingSessions,
  useCreateCoachingSession,
  useCreateSessionDelivery,
  useRevokeSessionDelivery,
  useSessionDeliveries,
} from '@/hooks/useCoachingSessions';
import { useFighterNameResolver } from '@/hooks/useFighterName';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { PendingButton } from '@/components/ui/pending-button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

function sessionRowLabel(t: TFunction, session: SessionResponse): string {
  return t('coaching.sessions.list.rowLabel', {
    date: new Date(session.date).toLocaleDateString(),
  });
}

/** "{{done}}/{{count}} tasks done" (plural on the total, mirroring the app's `_one`/`_other` convention), or a dash-free "No homework" for an empty checklist. */
function homeworkProgressLabel(t: TFunction, session: SessionResponse): string {
  const total = session.homework.length;
  if (total === 0) {
    return t('coaching.sessions.list.homeworkEmpty');
  }
  const done = session.homework.filter((item) => item.done).length;
  return t('coaching.sessions.list.homeworkProgress', { count: total, done, total });
}

interface SessionDeliveryMenuProps {
  clientId: string;
  session: SessionResponse;
}

/**
 * SESS-01 (D-10 immutability): the session row's delivery overflow menu — a
 * SEPARATE control from `Open`, mirroring `ReviewsListPage.tsx`'s
 * `ReviewDeliveryMenu`. Lazily fetches this session's delivery history only
 * once the menu is actually opened.
 */
function SessionDeliveryMenu({ clientId, session }: SessionDeliveryMenuProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const deliveries = useSessionDeliveries(clientId, session.sessionId, { enabled: open });
  const createDelivery = useCreateSessionDelivery(clientId, session.sessionId);
  const revokeDelivery = useRevokeSessionDelivery(clientId, session.sessionId);

  const activeDelivery: SessionDeliveryListItem | null =
    deliveries.data?.find((delivery) => delivery.revokedAt == null) ?? null;

  async function copyToClipboard(url: string) {
    if (typeof navigator === 'undefined' || !navigator.clipboard) {
      return;
    }
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      // Clipboard permission denied — the success toast for the underlying
      // create/reveal action still fires; copying is a convenience.
    }
  }

  async function handleDeliver() {
    try {
      const result = await createDelivery.mutateAsync();
      await copyToClipboard(result.url);
      toast.success(t('coaching.sessions.list.delivery.createdToast'));
    } catch {
      toast.error(t('coaching.sessions.list.delivery.createError'));
    }
  }

  async function handleCopyLink() {
    if (!activeDelivery) return;
    await copyToClipboard(activeDelivery.url);
    toast.success(t('coaching.sessions.list.delivery.copiedToast'));
  }

  async function handleRevoke() {
    if (!activeDelivery) return;
    try {
      await revokeDelivery.mutateAsync(activeDelivery.deliveryId);
      toast.success(t('coaching.sessions.list.delivery.revokedToast'));
    } catch {
      toast.error(t('coaching.sessions.list.delivery.revokeError'));
    }
  }

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          aria-label={t('coaching.sessions.list.deliveryMenuAria')}
        >
          <MoreHorizontal className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={handleDeliver}>
          {t('coaching.sessions.list.actions.deliver')}
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!activeDelivery} onSelect={handleCopyLink}>
          {t('coaching.sessions.list.actions.copyLink')}
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!activeDelivery} onSelect={handleRevoke}>
          {t('coaching.sessions.list.actions.revokeLink')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * SESS-02: the Sessions list — the 7th client-workspace nav item, beside
 * Reviews. One row per session showing the session date, character-tag
 * chips (fighter names), and a homework-progress indicator; an `Open`
 * button (→ the composer) plus a SEPARATE delivery overflow menu
 * (`SessionDeliveryMenu` above). `+ New session` logs a blank draft
 * directly and navigates to the composer, mirroring `ReviewsListPage.tsx`'s
 * `+ New review`.
 */
export function SessionsListPage() {
  const { t } = useTranslation();
  const { clientId = '' } = useParams<{ clientId: string }>();
  const navigate = useNavigate();
  const sessionsQuery = useCoachingSessions(clientId);
  const createSession = useCreateCoachingSession(clientId);
  const fighterName = useFighterNameResolver();

  async function handleCreateSession() {
    try {
      const created = await createSession.mutateAsync({ date: Date.now(), summary: '' });
      navigate(`/coach/${clientId}/sessions/${created.sessionId}`);
    } catch {
      toast.error(t('coaching.sessions.list.createError'));
    }
  }

  const sessions = sessionsQuery.data ?? [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {t('coaching.sessions.list.title')}
          </h1>
          <p className="text-sm text-muted-foreground">{t('coaching.sessions.list.subtitle')}</p>
        </div>
        <PendingButton
          type="button"
          onClick={handleCreateSession}
          pending={createSession.isPending}
        >
          <Plus className="size-4" />
          {t('coaching.sessions.list.newSession')}
        </PendingButton>
      </div>

      {sessionsQuery.isLoading ? (
        <p className="text-sm text-muted-foreground">{t('chrome.loading')}</p>
      ) : sessions.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('coaching.sessions.list.empty')}</p>
      ) : (
        <ul className="flex flex-col gap-2" aria-label={t('coaching.sessions.list.listAria')}>
          {sessions.map((session) => (
            <li
              key={session.sessionId}
              className="flex flex-col gap-2 rounded-md border bg-card px-4 py-3 sm:flex-row sm:flex-wrap sm:items-center sm:gap-3"
            >
              <div className="min-w-0 sm:flex-1">
                <p className="truncate text-sm font-medium">{sessionRowLabel(t, session)}</p>
                {session.characterTags.length > 0 && (
                  <div className="mt-1 flex flex-wrap items-center gap-1.5">
                    {session.characterTags.map((fighterId) => (
                      <Badge key={fighterId} variant="outline">
                        {fighterName(fighterId)}
                      </Badge>
                    ))}
                  </div>
                )}
              </div>
              <div className="flex items-center gap-2 sm:contents">
                <Badge variant="secondary">{homeworkProgressLabel(t, session)}</Badge>
              </div>
              <div className="flex items-center gap-2 sm:contents">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => navigate(`/coach/${clientId}/sessions/${session.sessionId}`)}
                >
                  {t('coaching.sessions.list.open')}
                </Button>
                <div className="ml-auto sm:ml-0">
                  <SessionDeliveryMenu clientId={clientId} session={session} />
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
