import { Link } from 'react-router';
import { Button } from '@/components/ui/button';

export function NotFoundPage() {
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
