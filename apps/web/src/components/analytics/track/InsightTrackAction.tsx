import { useTranslation } from 'react-i18next';
import type { Insight } from '@smash-tracker/shared';
import { TrackToggle } from '@/components/analytics/track/TrackToggle';
import { trackRefForInsight } from '@/components/analytics/track/trackRef';
import { getStageById } from '@/data/stages';
import { localizedFighterName } from '@/lib/fighterNames';

export interface InsightTrackActionProps {
  insight: Insight;
}

/**
 * The fourth Track host (UI-SPEC 7.7 host 4, DD-09): the `InsightCard.action`
 * for a card whose scope names an opponent, a matchup or a stage. It renders
 * the same `TrackToggle` the page headers carry, against the same subject
 * list, and nothing at all for an insight `trackRefForInsight` resolves to
 * `null`. A host hands it to the card only when the ref exists, so a
 * non-trackable card's DOM is unchanged.
 */
export function InsightTrackAction({ insight }: InsightTrackActionProps) {
  const { t } = useTranslation();
  const ref = trackRefForInsight(insight);
  if (ref === null) {
    return null;
  }

  let name: string;
  if (ref.kind === 'matchup') {
    const fighter = localizedFighterName(ref.nameParts.fighterId, t);
    const opponent = localizedFighterName(ref.nameParts.vsFighterId, t);
    name = t('matchups.pairingHeading', { fighter, opponent });
  } else if (ref.kind === 'stage') {
    name = getStageById(ref.nameParts.stageId)?.name ?? String(ref.nameParts.stageId);
  } else {
    name = ref.nameParts.tag;
  }

  return <TrackToggle kind={ref.kind} itemRef={ref.itemRef} name={name} />;
}
