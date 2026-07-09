import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
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
  const { t } = useTranslation();
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
        <CardTitle>{t('scout.title')}</CardTitle>
        <CardDescription>
          {parryggEnabled ? t('scout.form.descriptionWithParry') : t('scout.form.description')}
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
                    ? t('scout.form.placeholderWithParry')
                    : t('scout.form.placeholder')
                }
                className="pl-8"
                disabled={isPending}
                aria-label={
                  parryggEnabled ? t('scout.form.inputAriaWithParry') : t('scout.form.inputAria')
                }
              />
            </div>
            <Button type="submit" disabled={isPending || query.trim().length === 0}>
              {isPending ? t('scout.form.scouting') : t('scout.form.scout')}
            </Button>
          </div>

          {parryggEnabled && (
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">{t('scout.form.source')}</span>
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
                aria-label={t('scout.form.sourceAria')}
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
                  {t('scout.form.detectedParry')}
                </span>
              )}
            </div>
          )}
        </form>
        {isPending && (
          <p className="mt-2 text-sm text-muted-foreground">{t('scout.form.pending')}</p>
        )}
      </CardContent>
    </Card>
  );
}
