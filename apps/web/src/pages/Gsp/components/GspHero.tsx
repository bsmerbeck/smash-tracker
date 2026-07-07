import { useState } from 'react';
import type { ReactNode } from 'react';
import { Pencil, Check, X } from 'lucide-react';
import type { GspPoint, GspSettings } from '@smash-tracker/shared';
import { toast } from 'sonner';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useUpdateGspSettings } from '@/hooks/useGspSettings';

const ELITEGSP_URL = 'https://elitegsp.com';

function HeroCard({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-1">{children}</CardContent>
    </Card>
  );
}

/** Recent-window win rate (as a 0-1 fraction) over the trailing `windowSize` GSP-bearing matches. */
export function getRecentGspWinRate(series: GspPoint[], windowSize = 20): number | null {
  if (series.length === 0) return null;
  const recent = series.slice(-windowSize);
  const wins = recent.filter((p) => p.win).length;
  return wins / recent.length;
}

/**
 * GSP page hero row: current GSP reading, the user-editable Elite Smash
 * threshold (V10 — no public API for this, so the user maintains it, linking
 * out to elitegsp.com's crowd-sourced estimate for reference), distance to
 * Elite (or a celebration badge once at/above it), and recent GSP win rate.
 */
export function GspHero({ series, settings }: { series: GspPoint[]; settings: GspSettings }) {
  const currentGsp = series.length > 0 ? series[series.length - 1]!.gsp : null;
  const winRate = getRecentGspWinRate(series);
  const isElite = currentGsp !== null && currentGsp >= settings.eliteThreshold;

  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      <HeroCard label="Current GSP">
        {currentGsp !== null ? (
          <>
            <span className="text-3xl font-bold">{currentGsp.toLocaleString()}</span>
            <p className="text-sm text-muted-foreground">latest reading</p>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">No GSP logged yet</p>
        )}
      </HeroCard>

      <EliteThresholdCard settings={settings} />

      <HeroCard label="Distance to Elite">
        {currentGsp === null ? (
          <p className="text-sm text-muted-foreground">No GSP logged yet</p>
        ) : isElite ? (
          <span className="w-fit rounded-full bg-emerald-500/15 px-2 py-0.5 text-sm font-semibold text-emerald-500">
            ELITE
          </span>
        ) : (
          <>
            <span className="text-3xl font-bold">
              {(settings.eliteThreshold - currentGsp).toLocaleString()}
            </span>
            <p className="text-sm text-muted-foreground">GSP to go (estimate)</p>
          </>
        )}
      </HeroCard>

      <HeroCard label="Recent Win Rate">
        {winRate !== null ? (
          <>
            <span className="text-3xl font-bold">{Math.round(winRate * 100)}%</span>
            <p className="text-sm text-muted-foreground">
              last {Math.min(series.length, 20)} games
            </p>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">No GSP logged yet</p>
        )}
      </HeroCard>
    </div>
  );
}

function EliteThresholdCard({ settings }: { settings: GspSettings }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(settings.eliteThreshold));
  const updateSettings = useUpdateGspSettings();

  const lastUpdatedLabel =
    settings.updatedAt > 0 ? new Date(settings.updatedAt).toLocaleDateString() : 'never set';

  async function save() {
    const parsed = Number(draft);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      toast.error('Enter a positive whole number for the Elite threshold.');
      return;
    }
    try {
      await updateSettings.mutateAsync({ eliteThreshold: parsed });
      toast.success('Elite threshold updated!');
      setEditing(false);
    } catch {
      toast.error('Failed to save the Elite threshold. Please try again.');
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium text-muted-foreground">Elite Threshold</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-1">
        {editing ? (
          <div className="flex items-center gap-1">
            <Input
              type="number"
              min={1}
              step={1}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              aria-label="Elite Smash threshold"
              className="h-8 w-32"
              autoFocus
            />
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label="Save threshold"
              onClick={() => void save()}
              disabled={updateSettings.isPending}
            >
              <Check className="size-4" />
            </Button>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label="Cancel editing threshold"
              onClick={() => {
                setDraft(String(settings.eliteThreshold));
                setEditing(false);
              }}
            >
              <X className="size-4" />
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-1.5">
            <span className="text-3xl font-bold">{settings.eliteThreshold.toLocaleString()}</span>
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              aria-label="Edit Elite threshold"
              onClick={() => setEditing(true)}
            >
              <Pencil className="size-3.5" />
            </Button>
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          As of {lastUpdatedLabel} &middot;{' '}
          <a
            href={ELITEGSP_URL}
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-2 hover:text-foreground"
          >
            check elitegsp.com
          </a>
        </p>
      </CardContent>
    </Card>
  );
}
