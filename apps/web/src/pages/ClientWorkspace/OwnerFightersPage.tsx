import { useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useClientWorkspaces } from '@/hooks/useClientWorkspaces';
import { useFighters } from '@/hooks/useFighters';
import { useFighterSlotSelection } from '@/hooks/useFighterSlotSelection';
import { CharacterSelectScreen } from '@/pages/CharacterSelect/CharacterSelectScreen';

/**
 * Phase 24 (Coach Issuance & Client Claim Experience, CTRL-01):
 * `/workspace/:tenantId/fighters` — sets the owner's primary and secondary
 * fighters using the SAME `CharacterSelectScreen` the personal
 * `/choose-primary`/`/choose-secondary` routes use (not forked). Because
 * that component already reads/writes through the subject-scoped
 * `useFighters`/`useSaveFighters`, a save made here targets the claimed
 * workspace, not the owner's own personal library. The workspace label
 * comes from `useClientWorkspaces()` — never the coach hub's client list —
 * and the save destination is the workspace Overview.
 *
 * 260726-r4 (P0 data-loss fix): this page renders BOTH slots at once, so
 * this page — not either `CharacterSelectScreen` instance — owns both
 * slots' on-page selection via `combined`. That guarantees a save from
 * EITHER panel always sends a coherent `{primary, secondary}` pair
 * reflecting the current on-page state of both, never a stale
 * read-modify-write against the other slot; and a successful save stays on
 * this page (toast only) instead of navigating away, so the user can still
 * set the other slot.
 */
export function OwnerFightersPage() {
  const { t } = useTranslation();
  const { tenantId = '' } = useParams<{ tenantId: string }>();
  const workspaces = useClientWorkspaces();
  const workspaceLabel =
    workspaces.data?.find((workspace) => workspace.tenantId === tenantId)?.label ?? tenantId;
  const overviewHref = `/workspace/${tenantId}/overview`;

  const { data: fighters } = useFighters();
  const [primaryIds, setPrimaryIds] = useFighterSlotSelection(fighters, 'primary');
  const [secondaryIds, setSecondaryIds] = useFighterSlotSelection(fighters, 'secondary');

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          {workspaceLabel} — {t('ownerWorkspace.fighters.title')}
        </h1>
        <p className="text-sm text-muted-foreground">{t('ownerWorkspace.fighters.subtitle')}</p>
      </div>

      <CharacterSelectScreen
        slot="primary"
        heading={t('coaching.fighters.primaryHeading')}
        description={t('coaching.fighters.primaryDescription')}
        destinations={[{ label: t('ownerWorkspace.fighters.saveButton'), href: overviewHref }]}
        combined={{
          selectedIds: primaryIds,
          onSelectedIdsChange: setPrimaryIds,
          otherSlotIds: secondaryIds,
          onSaved: () => {},
        }}
      />

      <CharacterSelectScreen
        slot="secondary"
        heading={t('coaching.fighters.secondaryHeading')}
        description={t('coaching.fighters.secondaryDescription')}
        destinations={[{ label: t('ownerWorkspace.fighters.saveButton'), href: overviewHref }]}
        combined={{
          selectedIds: secondaryIds,
          onSelectedIdsChange: setSecondaryIds,
          otherSlotIds: primaryIds,
          onSaved: () => {},
        }}
      />
    </div>
  );
}
