import { useEffect, type ReactNode } from 'react';
import { useLocation } from 'react-router';
import { TooltipProvider } from '@/components/ui/tooltip';
import { logAnalyticsPageView } from '@/lib/firebase';
import { Sidebar } from './Sidebar';
import { Topbar } from './Topbar';
import { Footer } from './Footer';

/**
 * Authenticated app shell: Topbar + persistent desktop Sidebar (mobile nav
 * lives in a Sheet triggered from Topbar) + Footer. Mirrors the structure of
 * legacy/src/layouts/Main without pixel-matching it. Wrapped in
 * `TooltipProvider` so any page can use `Tooltip`/`TooltipTrigger` without
 * repeating the provider setup (first consumer: the tournament detail
 * page's stage-chip and Advisor Retrospective tooltips).
 */
export function MainLayout({ children }: { children: ReactNode }) {
  // GA4 only auto-collects the initial page load; SPA navigations are
  // reported here. No-ops entirely when analytics isn't configured.
  const location = useLocation();
  useEffect(() => {
    logAnalyticsPageView(location.pathname);
  }, [location.pathname]);

  return (
    <TooltipProvider>
      <div className="flex min-h-svh flex-col">
        <Topbar />
        <div className="flex flex-1">
          <Sidebar />
          <div className="flex min-w-0 flex-1 flex-col">
            <main className="flex-1 p-4 sm:p-6">{children}</main>
            <Footer />
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
}
