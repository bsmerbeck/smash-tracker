import { useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useCoachingClients } from '@/hooks/useCoachingClients';
import { CharacterSelectScreen } from '@/pages/CharacterSelect/CharacterSelectScreen';

/**
 * Phase 11 fix round 2 (D-03/D3): `/coach/:clientId/fighters` — sets the
 * client's primary AND secondary using the SAME `CharacterSelectScreen`
 * that powers the personal `/choose-primary`/`/choose-secondary` routes
 * (not forked). Because that component already reads/writes through the
 * subject-scoped `useFighters`/`useSaveFighters`, a save made here targets
 * the client, not the coach (PAR-03) — this page only supplies
 * workspace-relative save destinations so a successful save returns to the
 * client's Overview instead of the personal dashboard.
 */
export function ClientFightersPage() {
  const { t } = useTranslation();
  const { clientId = '' } = useParams<{ clientId: string }>();
  const clients = useCoachingClients();
  const clientLabel =
    clients.data?.find((client) => client.clientId === clientId)?.label ?? clientId;
  const overviewHref = `/coach/${clientId}/overview`;

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          {clientLabel} — {t('coaching.overview.fightersTitle')}
        </h1>
        <p className="text-sm text-muted-foreground">{t('coaching.fighters.subtitle')}</p>
      </div>

      <CharacterSelectScreen
        slot="primary"
        heading={t('coaching.fighters.primaryHeading')}
        description={t('coaching.fighters.primaryDescription')}
        destinations={[{ label: t('coaching.fighters.saveButton'), href: overviewHref }]}
      />

      <CharacterSelectScreen
        slot="secondary"
        heading={t('coaching.fighters.secondaryHeading')}
        description={t('coaching.fighters.secondaryDescription')}
        destinations={[{ label: t('coaching.fighters.saveButton'), href: overviewHref }]}
      />
    </div>
  );
}
