import { useState } from 'react';
import { Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export function ScoutSearchForm({
  onSubmit,
  isPending,
}: {
  onSubmit: (query: string) => void;
  isPending: boolean;
}) {
  const [query, setQuery] = useState('');

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = query.trim();
    if (trimmed) {
      onSubmit(trimmed);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Scout a Player</CardTitle>
        <CardDescription>
          Paste a start.gg profile URL, a "user/&lt;slug&gt;" reference, or a numeric player id to
          pull up their public tournament history before you play them.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="flex flex-col gap-3 sm:flex-row">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="https://start.gg/user/07dc2239"
              className="pl-8"
              disabled={isPending}
              aria-label="start.gg profile URL, slug, or player id"
            />
          </div>
          <Button type="submit" disabled={isPending || query.trim().length === 0}>
            {isPending ? 'Scouting…' : 'Scout'}
          </Button>
        </form>
        {isPending && (
          <p className="mt-2 text-sm text-muted-foreground">
            Pulling their public tournament history — this can take a few seconds.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
