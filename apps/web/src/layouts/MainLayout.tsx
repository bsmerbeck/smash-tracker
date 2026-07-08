import { type ReactNode } from 'react';
import { TooltipProvider } from '@/components/ui/tooltip';
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
  // page_view reporting lives in routes/RouteAnalytics.tsx (app-wide, public
  // pages included), not here.
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
