import type { ReactNode } from 'react';
import { Link } from 'react-router';

/**
 * V12 SEO: shell for public, unauthenticated, crawlable pages (`/faq`,
 * `/gsp-calculator`) — deliberately NOT `MainLayout` (no sidebar, no auth
 * dependency, no `useAuth`/analytics-filter context), so these pages render
 * identically whether or not Firebase Auth has resolved yet, which matters
 * both for prerendering (scripts/prerender.mjs snapshots the DOM before any
 * auth round-trip could complete) and for real signed-out visitors arriving
 * from search.
 */
export function PublicLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-svh flex-col">
      <header className="sticky top-0 z-40 flex h-14 items-center gap-4 border-b bg-background px-4">
        <Link to="/" className="text-lg font-semibold tracking-tight">
          grandfinals.gg
        </Link>
        <div className="flex-1" />
        <Link to="/" className="text-sm font-medium text-muted-foreground hover:text-foreground">
          Sign in
        </Link>
      </header>

      <main className="flex-1">{children}</main>

      <footer className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2 border-t px-4 py-6 text-sm text-muted-foreground">
        <Link to="/" className="hover:text-foreground hover:underline">
          Home
        </Link>
        <span aria-hidden="true">·</span>
        <Link to="/faq" className="hover:text-foreground hover:underline">
          FAQ
        </Link>
        <span aria-hidden="true">·</span>
        <Link to="/gsp-calculator" className="hover:text-foreground hover:underline">
          GSP Calculator
        </Link>
        <span aria-hidden="true">·</span>
        <a
          href="https://github.com/bsmerbeck/smash-tracker/"
          target="_blank"
          rel="noreferrer"
          className="hover:text-foreground hover:underline"
        >
          GitHub
        </a>
        <span aria-hidden="true">·</span>
        <a
          href="https://discord.gg/9TN8RFZ"
          target="_blank"
          rel="noreferrer"
          className="hover:text-foreground hover:underline"
        >
          Discord
        </a>
      </footer>
    </div>
  );
}
