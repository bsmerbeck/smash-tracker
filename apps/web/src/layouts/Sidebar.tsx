import { SidebarContent } from './SidebarContent';

/**
 * Persistent desktop sidebar. Hidden below the `lg` breakpoint (mobile uses
 * the Sheet drawer in Topbar instead).
 *
 * The sticky container sits BELOW the sticky Topbar (h-14), so its height
 * must be `100svh - 3.5rem` anchored at `top-14` — a plain `top-0 h-svh`
 * here extends one topbar-height past the viewport bottom, permanently
 * hiding the last footer item (the Donate button). `overflow-hidden` keeps
 * the nav (which has its own overflow-y-auto) as the only scroll region so
 * the profile block and footer stay pinned.
 */
export function Sidebar() {
  return (
    <aside className="hidden w-64 shrink-0 border-r bg-card lg:block">
      <div className="sticky top-14 h-[calc(100svh-3.5rem)] overflow-hidden">
        <SidebarContent />
      </div>
    </aside>
  );
}
