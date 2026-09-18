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
 *
 * Quick 260918-hro: `collapsed` returns `null` — a deliberate DOM removal,
 * not a CSS hide — when the app-shell rail preference is collapsed. The
 * content column in `MainLayout` is already `flex min-w-0 flex-1 flex-col`,
 * so removing this element from the DOM lets it absorb the freed width with
 * no other layout change. The control that brings the rail back lives in
 * the Topbar (not here), precisely because it must stay reachable in both
 * states — nothing inside this component can strand the user once it
 * renders nothing. The expanded path below (the `aside`/sticky height
 * chain) is left byte-identical, so the pinned-footer invariant this doc
 * comment calls out cannot regress.
 */
export function Sidebar({ collapsed }: { collapsed?: boolean }) {
  if (collapsed) return null;

  return (
    <aside className="hidden w-64 shrink-0 border-r bg-card lg:block">
      <div className="sticky top-14 h-[calc(100svh-3.5rem)] overflow-hidden">
        <SidebarContent />
      </div>
    </aside>
  );
}
