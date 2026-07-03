import { SidebarContent } from './SidebarContent';

/** Persistent desktop sidebar. Hidden below the `lg` breakpoint (mobile uses the Sheet drawer in Topbar instead). */
export function Sidebar() {
  return (
    <aside className="hidden w-64 shrink-0 border-r bg-card lg:block">
      <div className="sticky top-0 h-svh overflow-y-auto">
        <SidebarContent />
      </div>
    </aside>
  );
}
