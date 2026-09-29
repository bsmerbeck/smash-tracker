import { HorizonSwitch } from '@/components/analytics/HorizonSwitch';
import { PageFilterRow } from '@/components/analytics/PageFilterRow';
import { SelectFighter } from './SelectFighter';
import { AddMatchForm } from './AddMatchForm';

/**
 * Ports legacy/src/screens/Dashboard/components/DashboardToolbar.
 *
 * Plan 39.1-17 (INS-02, UI-SPEC §10.4): gains the page's ONE `HorizonSwitch`
 * on the right — self-contained (it makes its own `useHorizon` call, which
 * `useHorizon`'s same-subject broadcast keeps in step with the page's call),
 * so no prop threading is needed here.
 *
 * Plan 39.1-38 (UI-SPEC §10.4): renders the kit's one unboxed
 * `PageFilterRow` — picker + Add Match, spacer, HorizonSwitch. The Dashboard
 * has no page title today and gains none.
 */
export function DashboardToolbar() {
  return (
    <PageFilterRow
      leading={
        <div className="flex items-center gap-2">
          <SelectFighter />
          <AddMatchForm />
        </div>
      }
      trailing={<HorizonSwitch />}
    />
  );
}
