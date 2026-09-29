import { useTranslation } from 'react-i18next';
import type { HorizonKey, Match } from '@smash-tracker/shared';
import { filterByFighter } from '@/lib/stats';
import { localizedFighterName } from '@/lib/fighterNames';
import { useDashboardContext } from '../DashboardContext';
import { HorizonRecordCard } from './HeroStats';

/**
 * Ports legacy/src/screens/Dashboard/components/WinLossTracker.
 *
 * Plan 39.1-50 (OOS-12a, UI-SPEC §8.7 / §6.1): the selected fighter's record
 * is the hero row's sixth 3-span tile — no longer a separately titled,
 * centred, width-capped card whose "Overall Record" title collided with the
 * account-wide tile. It renders the Overall Record tile's own body
 * (`HorizonRecordCard`: one win-rate lead, a `Record` support line and a
 * DeltaChip on the page's ONE HorizonSwitch) over the selected fighter's
 * games, under an overline naming the fighter.
 */
export function WinLossTracker({ matches, horizon }: { matches: Match[]; horizon: HorizonKey }) {
  const { t } = useTranslation();
  const { fighter } = useDashboardContext();

  const fighterMatches = fighter ? filterByFighter(matches, fighter.id) : [];
  const label = fighter
    ? t('dashboard.hero.fighterRecord', { fighter: localizedFighterName(fighter.id, t) })
    : t('dashboard.hero.overallRecord');

  return (
    <HorizonRecordCard matches={fighterMatches} horizon={horizon} label={label}>
      <span data-slot="fighter-record-tile" className="contents" />
    </HorizonRecordCard>
  );
}
