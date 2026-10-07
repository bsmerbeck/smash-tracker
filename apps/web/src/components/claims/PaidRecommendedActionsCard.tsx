import { useMemo } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { StoredScoutReport } from '@smash-tracker/shared';
import { Button } from '@/components/ui/button';
import { RecommendedActionList, type ActionDoorRenderer } from './RecommendedActionsCard';
import { resolveStoredActions } from './storedActions';

/**
 * Phase 39 (plan 39-11, RPT-09 / D-12, 39-UI-SPEC §C): the recommended-actions
 * block on a PAID output (the scouting report card and the expanded practice
 * plan). It composes the free module's row list unchanged — same rows, same
 * cap, same empty state — and adds only the paid-side emphasis: the 39.1
 * door convention (`InsightCard`: the first door is primary) is on the tree,
 * so the FIRST row's door is the default button; every other door stays an
 * outline button. This emphasis lives here and only here, which is what keeps
 * the free card structurally unable to show it.
 *
 * The rows are the model's chosen slots, resolved through their stored claims
 * (`resolveStoredActions`).
 */

type StoredClaimMap = StoredScoutReport['claims'];
type StoredActionSlots = StoredScoutReport['actions'];

const renderPaidDoor: ActionDoorRenderer = (door, rowIndex) => (
  <Button asChild size="sm" variant={rowIndex === 0 ? 'default' : 'outline'}>
    <Link to={door.to}>{door.label}</Link>
  </Button>
);

export interface PaidRecommendedActionsCardProps {
  actions: StoredActionSlots;
  claims: StoredClaimMap;
}

export function PaidRecommendedActionsCard({ actions, claims }: PaidRecommendedActionsCardProps) {
  const { t } = useTranslation();
  const resolved = useMemo(() => resolveStoredActions({ actions, claims }), [actions, claims]);
  return (
    <div className="flex flex-col gap-2" data-recommended-actions="paid">
      <h3 className="text-sm font-semibold">{t('reports.actions.title')}</h3>
      <RecommendedActionList
        actions={resolved.actions}
        claims={resolved.claims}
        renderDoor={renderPaidDoor}
      />
    </div>
  );
}
