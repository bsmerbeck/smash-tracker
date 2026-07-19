import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Users } from 'lucide-react';
import type { ClientHubRow } from '@smash-tracker/shared';
import { api } from '@/lib/api';
import {
  useArchiveCoachingClient,
  useCoachingClients,
  useDeleteCoachingClient,
} from '@/hooks/useCoachingClients';
import { describeCoachingError } from './describeCoachingError';
import { CreateClientDialog } from './components/CreateClientDialog';
import { ClientHubTable } from './components/ClientHubTable';
import { DeleteClientDialog } from './components/DeleteClientDialog';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';

/** Triggers a browser download of a client workspace export (TEN-06). */
function downloadClientExport(data: unknown, label: string): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  const safeLabel =
    label
      .trim()
      .replace(/[^a-z0-9-]+/gi, '-')
      .toLowerCase() || 'client';
  link.download = `${safeLabel}-export.json`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/**
 * Phase 11 (Coach Workspace Tenancy & Feature Parity, TEN-05/TEN-06): `/coach`
 * — the Client Hub. Zero-client state is a single "Create your first client"
 * CTA (CONTEXT.md, preserved from the 11-05 landing shell); once clients
 * exist, the compact searchable/sortable/paginated `ClientHubTable`
 * (TEN-05) plus the full lifecycle: create (409 re-prompt), soft
 * archive/restore, type-the-name hard delete (server-side cascade), and
 * JSON export (TEN-06).
 *
 * Retention/cascade rules (TEN-06, documented here and in the SUMMARY):
 * - **Archive** — soft, restorable. Sets `archivedAt` on the tenant + index
 *   records only; no data is touched. Hidden from the default (non-archived)
 *   listing; visible again via the "Show archived" toggle below, which also
 *   restores.
 * - **Delete** — hard, irreversible. Requires typing the client's exact
 *   label. Cascades a multi-path `null`-delete across every one of the
 *   client's data trees server-side
 *   (`apps/api/src/coaching/tenants.ts`'s `CANONICAL_TENANT_TREES`) plus the
 *   tenant/index/membership records. No direct-DB repair exists or is
 *   offered.
 * - **Export** — a synchronous JSON dump of the client's workspace (matches,
 *   playlists, opponents, opponent aliases/notes, stage favorites, fighter
 *   selection) via `GET /api/coaching/clients/:id/export`. Available for
 *   both active and archived clients.
 */
export function ClientHubPage() {
  const { t } = useTranslation();
  const [showArchived, setShowArchived] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<ClientHubRow | null>(null);

  const activeClients = useCoachingClients();
  const archivedView = useCoachingClients({ includeArchived: true, enabled: showArchived });
  const visibleClients = showArchived ? archivedView : activeClients;

  const archiveClient = useArchiveCoachingClient();
  const deleteClient = useDeleteCoachingClient();

  const activeList = activeClients.data ?? [];
  const list = visibleClients.data ?? [];
  const isEmpty = !activeClients.isLoading && activeList.length === 0;

  function handleArchiveToggle(client: ClientHubRow) {
    const archived = client.archivedAt == null;
    archiveClient.mutate(
      { clientId: client.clientId, archived },
      {
        onSuccess: () => {
          toast.success(
            archived
              ? t('coaching.hub.archive.archived', { label: client.label })
              : t('coaching.hub.archive.restored', { label: client.label }),
          );
        },
        onError: (error) => {
          toast.error(describeCoachingError(error, t('coaching.hub.archive.error')));
        },
      },
    );
  }

  function handleDeleteConfirm(client: ClientHubRow) {
    deleteClient.mutate(client.clientId, {
      onSuccess: () => {
        toast.success(t('coaching.hub.delete.deleted', { label: client.label }));
        setPendingDelete(null);
      },
      onError: (error) => {
        toast.error(describeCoachingError(error, t('coaching.hub.delete.error')));
      },
    });
  }

  async function handleExport(client: ClientHubRow) {
    try {
      const data = await api.coaching.clients.export(client.clientId);
      downloadClientExport(data, client.label);
      toast.success(t('coaching.hub.export.success', { label: client.label }));
    } catch (error) {
      toast.error(describeCoachingError(error, t('coaching.hub.export.error')));
    }
  }

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">{t('coaching.hub.title')}</h1>
        {!isEmpty && <CreateClientDialog triggerLabel={t('coaching.hub.createAnotherTrigger')} />}
      </div>

      {activeClients.isLoading && (
        <div className="text-muted-foreground">{t('coaching.hub.loading')}</div>
      )}

      {isEmpty && (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed p-16 text-center">
          <Users className="size-8 text-muted-foreground" />
          <h2 className="text-lg font-semibold">{t('coaching.hub.empty.title')}</h2>
          <p className="max-w-sm text-sm text-muted-foreground">{t('coaching.hub.empty.body')}</p>
          <CreateClientDialog triggerLabel={t('coaching.hub.createTrigger')} />
        </div>
      )}

      {!isEmpty && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-muted-foreground">
              {t('coaching.hub.clients', { count: activeList.length })}
            </p>
            <div className="flex items-center gap-2">
              <Switch
                id="coaching-hub-show-archived"
                checked={showArchived}
                onCheckedChange={setShowArchived}
              />
              <Label htmlFor="coaching-hub-show-archived" className="text-sm font-normal">
                {t('coaching.hub.showArchived')}
              </Label>
            </div>
          </div>

          <ClientHubTable
            clients={list}
            onArchiveToggle={handleArchiveToggle}
            onExport={handleExport}
            onDeleteRequest={setPendingDelete}
          />
        </>
      )}

      <DeleteClientDialog
        client={pendingDelete}
        onOpenChange={(open) => !open && setPendingDelete(null)}
        onConfirm={handleDeleteConfirm}
        isPending={deleteClient.isPending}
      />
    </div>
  );
}
