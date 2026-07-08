import { Link } from 'react-router';
import { Button } from '@/components/ui/button';
import { useSeo } from '@/hooks/useSeo';

/** V12 SEO: noindex — a 404 page has no unique content worth ranking, and indexing it would waste crawl budget. */
export function NotFoundPage() {
  useSeo({ title: 'Page not found | Smash Tracker', noindex: true });

  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-4 px-4 text-center">
      <h1 className="text-4xl font-bold tracking-tight">404</h1>
      <p className="text-muted-foreground">This page doesn&apos;t exist.</p>
      <Button asChild>
        <Link to="/">Go home</Link>
      </Button>
    </div>
  );
}
