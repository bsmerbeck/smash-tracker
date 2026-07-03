import { SelectFighter } from './SelectFighter';
import { AddMatchForm } from './AddMatchForm';

/** Ports legacy/src/screens/Dashboard/components/DashboardToolbar. */
export function DashboardToolbar() {
  return (
    <div className="flex items-center justify-between gap-2">
      <SelectFighter />
      <AddMatchForm />
    </div>
  );
}
