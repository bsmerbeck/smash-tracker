import type { ReactNode } from 'react';
import { Sidebar } from './Sidebar';
import { Topbar } from './Topbar';
import { Footer } from './Footer';

/**
 * Authenticated app shell: Topbar + persistent desktop Sidebar (mobile nav
 * lives in a Sheet triggered from Topbar) + Footer. Mirrors the structure of
 * legacy/src/layouts/Main without pixel-matching it.
 */
export function MainLayout({ children }: { children: ReactNode }) {
  return (
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
  );
}
