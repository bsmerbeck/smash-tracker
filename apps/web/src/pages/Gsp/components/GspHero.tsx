import { useState } from 'react';
import type { ReactNode } from 'react';
import { Pencil, Check, X } from 'lucide-react';
import type { GspPoint, GspSettings } from '@smash-tracker/shared';
import { GSP_MODEL } from '@smash-tracker/shared';
import { toast } from 'sonner';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useUpdateGspSettings } from '@/hooks/useGspSettings';
import { parseGspNumber } from '../lib/parseGspNumber';
import {
  GSP_MMR_DOC_URL,
  calibrationFromSettings,
  computedEliteThreshold,
  estimateMmrAt,
} from '../lib/gspMmrModel';
import { useNowMs } from '../lib/useNowMs';

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
 * GSP page hero row (V10.1): current GSP reading, the estimated hidden MMR
 * behind it (community reverse-engineered model — see
 * packages/shared/src/gspMmr.ts), the COMPUTED Elite Smash threshold (still
 * editable — an edit now recalibrates the model's time-drift parameter
 * rather than pinning the displayed value), distance to Elite reframed on
 * the MMR scale (Elite entry is a fixed MMR, 1142, unlike the ever-drifting
 * GSP threshold), and recent GSP win rate.
 */
export function GspHero({ series, settings }: { series: GspPoint[]; settings: GspSettings }) {
  const lastPoint = series.length > 0 ? series[series.length - 1]! : null;
  const winRate = getRecentGspWinRate(series);

  const calibration = calibrationFromSettings(settings);
  const estimate =
    lastPoint !== null ? estimateMmrAt(lastPoint.gsp, lastPoint.time, calibration) : null;
  const roundedMmr = estimate !== null ? Math.round(estimate.mmr) : null;
  const isElite = roundedMmr !== null && roundedMmr >= GSP_MODEL.ELITE_MMR;

  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
      <HeroCard label="Current GSP">
        {lastPoint !== null ? (
          <>
            <span className="text-3xl font-bold">{lastPoint.gsp.toLocaleString()}</span>
            <p className="text-sm text-muted-foreground">latest reading</p>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">No GSP logged yet</p>
        )}
      </HeroCard>

      <HeroCard label="Est. MMR">
        {estimate !== null && roundedMmr !== null ? (
          <>
            <span className="text-3xl font-bold">{roundedMmr.toLocaleString()}</span>
            {estimate.zone !== 'main' && (
              <p className="text-xs font-medium text-amber-500">
                {estimate.zone}-tail reading &mdash; approximate
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              <a
                href={GSP_MMR_DOC_URL}
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-2 hover:text-foreground"
              >
                community-reverse-engineered model
              </a>{' '}
              (&plusmn;1 GSP in the main curve; tails approximate)
            </p>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">No GSP logged yet</p>
        )}
      </HeroCard>

      <EliteThresholdCard settings={settings} />

      <HeroCard label="Distance to Elite">
        {roundedMmr === null ? (
          <p className="text-sm text-muted-foreground">No GSP logged yet</p>
        ) : isElite ? (
          <span className="w-fit rounded-full bg-emerald-500/15 px-2 py-0.5 text-sm font-semibold text-emerald-500">
            ELITE
          </span>
        ) : (
          <>
            <span className="text-3xl font-bold">
              {(GSP_MODEL.ELITE_MMR - roundedMmr).toLocaleString()}
            </span>
            <p className="text-sm text-muted-foreground">
              MMR {roundedMmr.toLocaleString()} &middot; below Elite ({GSP_MODEL.ELITE_MMR})
            </p>
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

/**
 * V10.1: shows the COMPUTED current Elite entry GSP — Elite is a fixed MMR
 * (1142), so the GSP threshold is derived from the model's time-drift
 * parameter t, recalibrated by the user's most recent edit (stored via the
 * same settings API as V10; `eliteThreshold` + `updatedAt` double as the
 * calibration point, no schema change). Editing no longer pins the displayed
 * number — it feeds the model a fresh (value, timestamp) observation and the
 * display keeps drifting forward from there, same as the real threshold does.
 */
function EliteThresholdCard({ settings }: { settings: GspSettings }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(settings.eliteThreshold));
  const updateSettings = useUpdateGspSettings();

  const nowMs = useNowMs();
  const calibration = calibrationFromSettings(settings);
  const computed = computedEliteThreshold(nowMs, calibration);

  const calibrationLabel =
    settings.updatedAt > 0
      ? `recalibrated ${new Date(settings.updatedAt).toLocaleDateString()}`
      : 'from the model anchor';

  async function save() {
    const parsed = parseGspNumber(draft);
    if (parsed === null || parsed <= 0) {
      toast.error('Enter a positive whole number — commas are fine, e.g. 10,300,000.');
      return;
    }
    try {
      await updateSettings.mutateAsync({ eliteThreshold: parsed });
      toast.success('Model recalibrated from your threshold reading!');
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
            {/* type="text": browsers reject comma pastes into type="number",
                and the whole point is pasting straight from elitegsp.com. */}
            <Input
              type="text"
              inputMode="numeric"
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
            <span className="text-3xl font-bold">{computed.toLocaleString()}</span>
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
          computed &middot; {calibrationLabel} &middot; editing recalibrates the model &mdash; grab
          the current number from{' '}
          <a
            href={ELITEGSP_URL}
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-2 hover:text-foreground"
          >
            elitegsp.com
          </a>
        </p>
      </CardContent>
    </Card>
  );
}
