import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Search } from 'lucide-react';
import type { ScoutSource } from '@smash-tracker/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';

/** What the form hands back on submit — a single-source query, or (V13) a combined one. */
export interface ScoutSubmitRequest {
  query: string;
  source: ScoutSource;
  /** V13: a second lookup on the OTHER site to merge in. Present only in "Both" mode with both fields filled. */
  combineWith?: { query: string; source: ScoutSource };
}

/** The three source modes the toggle offers when parry.gg is enabled. */
type ScoutMode = ScoutSource | 'both';

/**
 * Client-side hint only — a lightweight mirror of the server's own
 * `parseParryProfileUrl` detection (apps/api/src/parrygg/scout.ts), used
 * purely to auto-select/disable the source toggle when the pasted text is
 * unambiguously a parry.gg profile URL. The SERVER re-detects and overrides
 * regardless of what `source` is sent, so this never needs to be exhaustive
 * — a false negative here just means the toggle doesn't visually flip before
 * submit, not an incorrect scout. Only relevant in the single-source modes;
 * "Both" mode has an explicit field per site.
 */
function looksLikeParryProfileUrl(value: string): boolean {
  return /parry\.gg\/profile\//i.test(value.trim());
}

export function ScoutSearchForm({
  onSubmit,
  isPending,
  parryggEnabled = false,
}: {
  onSubmit: (request: ScoutSubmitRequest) => void;
  isPending: boolean;
  /** Hides the source toggle (and the "Both" mode) entirely when parry.gg isn't configured on this deployment (V9-B Feature 4). */
  parryggEnabled?: boolean;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  // V13 "Both" mode keeps an explicit field per site (no auto-detect needed).
  const [startggQuery, setStartggQuery] = useState('');
  const [parryQuery, setParryQuery] = useState('');
  const [mode, setMode] = useState<ScoutMode>('startgg');

  const combineMode = mode === 'both';
  const detectedParryUrl = useMemo(
    () => !combineMode && looksLikeParryProfileUrl(query),
    [combineMode, query],
  );
  // Single-source effective source honors the pasted-parry-URL override.
  const singleSource: ScoutSource = detectedParryUrl
    ? 'parrygg'
    : mode === 'parrygg'
      ? 'parrygg'
      : 'startgg';
  // The toggle reflects the detected-parry override in single mode, else the raw mode.
  const toggleValue: ScoutMode = detectedParryUrl ? 'parrygg' : mode;

  const canSubmit = combineMode
    ? startggQuery.trim().length > 0 || parryQuery.trim().length > 0
    : query.trim().length > 0;

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (combineMode) {
      const sgg = startggQuery.trim();
      const pgg = parryQuery.trim();
      if (sgg && pgg) {
        onSubmit({
          query: sgg,
          source: 'startgg',
          combineWith: { query: pgg, source: 'parrygg' },
        });
      } else if (sgg) {
        onSubmit({ query: sgg, source: 'startgg' });
      } else if (pgg) {
        onSubmit({ query: pgg, source: 'parrygg' });
      }
      return;
    }
    const trimmed = query.trim();
    if (trimmed) {
      onSubmit({ query: trimmed, source: singleSource });
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
          {combineMode ? (
            // V13 combined scouting: an explicit handle per site. Either alone
            // scouts a single site; both together merge into one report.
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-1.5">
                <label htmlFor="scout-startgg" className="text-sm font-medium">
                  {t('scout.form.startggField')}
                </label>
                <Input
                  id="scout-startgg"
                  value={startggQuery}
                  onChange={(event) => setStartggQuery(event.target.value)}
                  placeholder={t('scout.form.placeholder')}
                  disabled={isPending}
                  aria-label={t('scout.form.startggFieldAria')}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <label htmlFor="scout-parrygg" className="text-sm font-medium">
                  {t('scout.form.parryField')}
                </label>
                <Input
                  id="scout-parrygg"
                  value={parryQuery}
                  onChange={(event) => setParryQuery(event.target.value)}
                  placeholder={t('scout.form.parryPlaceholder')}
                  disabled={isPending}
                  aria-label={t('scout.form.parryFieldAria')}
                />
              </div>
            </div>
          ) : (
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
          )}

          {parryggEnabled && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm text-muted-foreground">{t('scout.form.source')}</span>
              <ToggleGroup
                type="single"
                variant="outline"
                size="sm"
                value={toggleValue}
                disabled={detectedParryUrl}
                onValueChange={(value) => {
                  if (value === 'startgg' || value === 'parrygg' || value === 'both') {
                    setMode(value);
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
                <ToggleGroupItem value="both" aria-label={t('scout.form.combineBoth')}>
                  {t('scout.form.combineBoth')}
                </ToggleGroupItem>
              </ToggleGroup>
              {detectedParryUrl && (
                <span className="text-xs text-muted-foreground">
                  {t('scout.form.detectedParry')}
                </span>
              )}
            </div>
          )}

          {combineMode && (
            <p className="text-xs text-muted-foreground">{t('scout.form.combineHint')}</p>
          )}

          <Button type="submit" disabled={isPending || !canSubmit} className="w-fit">
            {isPending ? t('scout.form.scouting') : t('scout.form.scout')}
          </Button>
        </form>
        {isPending && (
          <p className="mt-2 text-sm text-muted-foreground">{t('scout.form.pending')}</p>
        )}
      </CardContent>
    </Card>
  );
}
