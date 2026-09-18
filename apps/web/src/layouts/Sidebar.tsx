import { useTranslation } from 'react-i18next';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
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
 * Quick 260918-hro: the rail collapses from a chevron on its own edge,
 * mirroring the VOD Manager's in-page rail (`VodManagerPage`): right-aligned
 * above the content while expanded, alone in a narrow strip while collapsed.
 * Collapsing REMOVES `SidebarContent` from the DOM (not a CSS hide); the
 * strip stays so the control is reachable in both states, and the content
 * column in `MainLayout` (`flex min-w-0 flex-1`) absorbs the freed width.
 * The chevron row is a fixed-height flex child and `SidebarContent` gets the
 * remaining `min-h-0 flex-1`, so the pinned-footer invariant above holds.
 * `MainLayout` owns the preference; the control renders only when `onToggle`
 * is supplied.
 */
export function Sidebar({ collapsed, onToggle }: { collapsed?: boolean; onToggle?: () => void }) {
  const { t } = useTranslation();

  const toggle = onToggle && (
    <Button
      type="button"
      variant="outline"
      size="icon-sm"
      onClick={onToggle}
      aria-expanded={!collapsed}
      aria-controls={collapsed ? undefined : 'app-sidebar-panel'}
      aria-label={collapsed ? t('chrome.expandSidebarAria') : t('chrome.collapseSidebarAria')}
    >
      {collapsed ? <ChevronRight /> : <ChevronLeft />}
    </Button>
  );

  if (collapsed) {
    return (
      <aside className="hidden shrink-0 border-r bg-card lg:block">
        <div className="sticky top-14 p-2">{toggle}</div>
      </aside>
    );
  }

  return (
    <aside className="hidden w-64 shrink-0 border-r bg-card lg:block">
      <div className="sticky top-14 flex h-[calc(100svh-3.5rem)] flex-col overflow-hidden">
        {toggle && <div className="flex shrink-0 justify-end px-2 pt-2">{toggle}</div>}
        <div id="app-sidebar-panel" className="min-h-0 flex-1">
          <SidebarContent />
        </div>
      </div>
    </aside>
  );
}
