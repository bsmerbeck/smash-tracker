import { HorizonSwitch } from '@/components/analytics/HorizonSwitch';
import { SelectFighter } from './SelectFighter';
import { AddMatchForm } from './AddMatchForm';

/**
 * Ports legacy/src/screens/Dashboard/components/DashboardToolbar.
 *
 * Plan 39.1-17 (INS-02, UI-SPEC §10.4): gains the page's ONE `HorizonSwitch`
 * on the right — self-contained (it makes its own `useHorizon` call, which
 * `useHorizon`'s same-subject broadcast keeps in step with the page's call),
 * so no prop threading is needed here.
 */
export function DashboardToolbar() {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex items-center gap-2">
        <SelectFighter />
        <AddMatchForm />
      </div>
      <HorizonSwitch />
    </div>
  );
}
