import { useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import type { ScoutSource } from '@smash-tracker/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';

/**
 * Client-side hint only — a lightweight mirror of the server's own
 * `parseParryProfileUrl` detection (apps/api/src/parrygg/scout.ts), used
 * purely to auto-select/disable the source toggle when the pasted text is
 * unambiguously a parry.gg profile URL. The SERVER re-detects and overrides
 * regardless of what `source` is sent, so this never needs to be exhaustive
 * — a false negative here just means the toggle doesn't visually flip before
 * submit, not an incorrect scout.
 */
function looksLikeParryProfileUrl(value: string): boolean {
  return /parry\.gg\/profile\//i.test(value.trim());
}

export function ScoutSearchForm({
  onSubmit,
  isPending,
  parryggEnabled = false,
}: {
  onSubmit: (query: string, source: ScoutSource) => void;
  isPending: boolean;
  /** Hides the source toggle entirely when parry.gg isn't configured on this deployment (V9-B Feature 4). */
  parryggEnabled?: boolean;
}) {
  const [query, setQuery] = useState('');
  const [source, setSource] = useState<ScoutSource>('startgg');

  const detectedParryUrl = useMemo(() => looksLikeParryProfileUrl(query), [query]);
  const effectiveSource: ScoutSource = detectedParryUrl ? 'parrygg' : source;

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = query.trim();
    if (trimmed) {
      onSubmit(trimmed, effectiveSource);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Scout a Player</CardTitle>
        <CardDescription>
          {parryggEnabled
            ? 'Paste a start.gg or parry.gg profile URL, a bare gamer tag, a "user/<slug>" reference, or a numeric player id to pull up their public tournament history before you play them.'
            : 'Paste a start.gg profile URL, a "user/<slug>" reference, or a numeric player id to pull up their public tournament history before you play them.'}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <div className="flex flex-col gap-3 sm:flex-row">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={
                  parryggEnabled
                    ? 'https://start.gg/user/07dc2239 or a parry.gg profile URL'
                    : 'https://start.gg/user/07dc2239'
                }
                className="pl-8"
                disabled={isPending}
                aria-label={
                  parryggEnabled
                    ? 'start.gg or parry.gg profile URL, slug/tag, or player id'
                    : 'start.gg profile URL, slug, or player id'
                }
              />
            </div>
            <Button type="submit" disabled={isPending || query.trim().length === 0}>
              {isPending ? 'Scouting…' : 'Scout'}
            </Button>
          </div>

          {parryggEnabled && (
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">Source:</span>
              <ToggleGroup
                type="single"
                variant="outline"
                size="sm"
                value={effectiveSource}
                disabled={detectedParryUrl}
                onValueChange={(value) => {
                  if (value === 'startgg' || value === 'parrygg') {
                    setSource(value);
                  }
                }}
                aria-label="Scouting source"
              >
                <ToggleGroupItem value="startgg" aria-label="start.gg">
                  start.gg
                </ToggleGroupItem>
                <ToggleGroupItem value="parrygg" aria-label="parry.gg">
                  parry.gg
                </ToggleGroupItem>
              </ToggleGroup>
              {detectedParryUrl && (
                <span className="text-xs text-muted-foreground">
                  Detected a parry.gg profile URL.
                </span>
              )}
            </div>
          )}
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
