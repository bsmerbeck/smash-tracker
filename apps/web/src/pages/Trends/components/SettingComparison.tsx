import type { Match } from '@smash-tracker/shared';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { getOnlineOfflineSplit, type OnlineOfflineSplit, type WinLossRecord } from '@/lib/stats';

/** Minimum sample size (each side) required before the takeaway line is shown, rather than a small-sample note. */
export const TAKEAWAY_MIN_SAMPLE = 10;

export interface SettingTakeaway {
  kind: 'takeaway' | 'small-sample';
  /** Populated when `kind === 'takeaway'`: which setting wins and by how many points. Absolute value; sign is implied by `better`. */
  deltaPoints?: number;
  better?: 'online' | 'offline';
}

/**
 * Builds the one-line online-vs-offline takeaway. Only compares when both
 * samples meet `TAKEAWAY_MIN_SAMPLE`; otherwise reports `small-sample` so the
 * caller renders a neutral note instead of a possibly-noisy claim. A tie
 * (equal win rate) reports `better: 'online'` with a zero delta — callers
 * should treat a zero delta as "even", not "online wins".
 */
export function buildSettingTakeaway(split: OnlineOfflineSplit): SettingTakeaway {
  if (split.online.total < TAKEAWAY_MIN_SAMPLE || split.offline.total < TAKEAWAY_MIN_SAMPLE) {
    return { kind: 'small-sample' };
  }
  const delta = split.online.winRate - split.offline.winRate;
  return {
    kind: 'takeaway',
    deltaPoints: Math.abs(delta),
    better: delta >= 0 ? 'online' : 'offline',
  };
}

/**
 * V3 Phase F: online vs offline vs unspecified setting comparison. Three
 * stat blocks plus a one-line takeaway, gated on both online and offline
 * having at least `TAKEAWAY_MIN_SAMPLE` games.
 */
export function SettingComparison({ matches }: { matches: Match[] }) {
  const split = getOnlineOfflineSplit(matches);
  const takeaway = buildSettingTakeaway(split);
  const hasAny = split.online.total > 0 || split.offline.total > 0 || split.unspecified.total > 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Setting Comparison</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {!hasAny ? (
          <p className="text-sm text-muted-foreground">No match data to report yet.</p>
        ) : (
          <>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <SettingBlock label="Online" record={split.online} />
              <SettingBlock label="Offline" record={split.offline} />
              <SettingBlock label="Unspecified" record={split.unspecified} />
            </div>

            {takeaway.kind === 'takeaway' ? (
              <p className="text-sm">
                {takeaway.deltaPoints === 0 ? (
                  <span>You win about the same rate online and offline.</span>
                ) : (
                  <span>
                    You win{' '}
                    <span className="font-semibold text-foreground">{takeaway.deltaPoints}%</span>{' '}
                    more{' '}
                    {takeaway.better === 'online' ? 'online than offline' : 'offline than online'}.
                  </span>
                )}
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                Need at least {TAKEAWAY_MIN_SAMPLE} games both online and offline for a reliable
                comparison.
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function SettingBlock({ label, record }: { label: string; record: WinLossRecord }) {
  if (record.total === 0) {
    return (
      <div className="rounded-md border p-3">
        <h3 className="text-sm text-muted-foreground">{label}</h3>
        <p className="text-sm text-muted-foreground">no data</p>
      </div>
    );
  }
  return (
    <div className="rounded-md border p-3">
      <h3 className="text-sm text-muted-foreground">{label}</h3>
      <p className="text-2xl font-semibold">{record.winRate}%</p>
      <p className="text-xs text-muted-foreground">
        {record.wins}-{record.losses} ({record.total} games)
      </p>
    </div>
  );
}
