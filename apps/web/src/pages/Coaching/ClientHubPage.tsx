import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Users } from 'lucide-react';
import { useCoachingClients } from '@/hooks/useCoachingClients';
import { CreateClientDialog } from './components/CreateClientDialog';

/**
 * Phase 11 (Coach Workspace Tenancy & Feature Parity, TEN-05): `/coach` —
 * the Client Hub landing shell. Zero-client state is a single "Create your
 * first client" CTA (CONTEXT.md); once clients exist, a minimal list links
 * into each client's workspace at `/coach/:clientId/vods`. The full compact
 * searchable table (search/sort/pagination, last-activity, draft/delivery
 * state, archive action) is enriched in 11-06 — this plan ships the shell.
 */
export function ClientHubPage() {
  const { t } = useTranslation();
  const clients = useCoachingClients();
  const list = clients.data ?? [];

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">{t('coaching.hub.title')}</h1>
        {list.length > 0 && (
          <CreateClientDialog triggerLabel={t('coaching.hub.createAnotherTrigger')} />
        )}
      </div>

      {clients.isLoading && (
        <div className="text-muted-foreground">{t('coaching.hub.loading')}</div>
      )}

      {!clients.isLoading && list.length === 0 && (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed p-16 text-center">
          <Users className="size-8 text-muted-foreground" />
          <h2 className="text-lg font-semibold">{t('coaching.hub.empty.title')}</h2>
          <p className="max-w-sm text-sm text-muted-foreground">{t('coaching.hub.empty.body')}</p>
          <CreateClientDialog triggerLabel={t('coaching.hub.createTrigger')} />
        </div>
      )}

      {list.length > 0 && (
        <>
          <p className="text-sm text-muted-foreground">
            {t('coaching.hub.clients', { count: list.length })}
          </p>
          <ul className="flex flex-col gap-2">
            {list.map((client) => (
              <li key={client.clientId}>
                <Link
                  to={`/coach/${client.clientId}/vods`}
                  className="flex items-center justify-between rounded-lg border p-4 text-sm transition-colors hover:bg-accent hover:text-accent-foreground"
                >
                  <span className="font-medium">{client.label}</span>
                  <span className="text-muted-foreground">{t('coaching.hub.openWorkspace')}</span>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
