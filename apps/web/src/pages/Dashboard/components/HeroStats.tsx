import type { Match } from '@smash-tracker/shared';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { WinLossPips } from '@/components/WinLossPips';
import {
  getOnlineOfflineSplit,
  getStreakSummary,
  getWinLossRecord,
  type WinLossRecord,
} from '@/lib/stats';
import { filterBySource } from '@/hooks/useFilteredMatches';

/**
 * Account-wide hero row: overall record, recent form, casual-vs-competitive
 * delta, and online/offline split. Unlike the fighter-scoped widgets below
 * it on the dashboard, every card here is computed across ALL of the user's
 * fighters (docs/analytics-vision.md Phase C).
 */
export function HeroStats({
  matches,
  timeFilteredMatches,
}: {
  /** Matches with the full global filter (source + time range) applied. */
  matches: Match[];
  /** Matches with only the time-range filter applied — used by the casual/competitive split so it can show both buckets regardless of the active source filter. */
  timeFilteredMatches: Match[];
}) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <OverallRecordCard matches={matches} />
      <FormCard matches={matches} />
      <CasualVsCompetitiveCard matches={timeFilteredMatches} />
      <OnlineOfflineCard matches={matches} />
    </div>
  );
}

function OverallRecordCard({ matches }: { matches: Match[] }) {
  const { wins, losses, total, winRate } = getWinLossRecord(matches);
  const hasMatches = total > 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Overall Record</CardTitle>
      </CardHeader>
      <CardContent>
        {hasMatches ? (
          <div className="flex items-end justify-between">
            <div>
              <span className="text-3xl font-bold">
                {wins}-{losses}
              </span>
              <p className="text-sm text-muted-foreground">{winRate}% win rate</p>
            </div>
            <span className="text-sm text-muted-foreground">{total} games</span>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No match data to report yet.</p>
        )}
      </CardContent>
    </Card>
  );
}

function FormCard({ matches }: { matches: Match[] }) {
  const { currentStreak, currentStreakIsWin } = getStreakSummary(matches);
  const hasMatches = matches.length > 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Form</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <WinLossPips matches={matches} limit={10} />
        {hasMatches && (
          <span
            className={`w-fit rounded-full px-2 py-0.5 text-sm font-semibold ${
              currentStreakIsWin
                ? 'bg-emerald-500/15 text-emerald-500'
                : 'bg-destructive/15 text-destructive'
            }`}
          >
            {currentStreak}
            {currentStreakIsWin ? 'W' : 'L'}
          </span>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Casual (manual) vs competitive (start.gg) win-rate side by side. Computes
 * from `matches` ignoring the global SOURCE filter — callers pass
 * `timeFilteredMatches` so the time range still applies but the source
 * split isn't collapsed by it.
 */
function CasualVsCompetitiveCard({ matches }: { matches: Match[] }) {
  const casual = getWinLossRecord(filterBySource(matches, 'manual'));
  const competitive = getWinLossRecord(filterBySource(matches, 'startgg'));
  const bothHaveData = casual.total > 0 && competitive.total > 0;
  const delta = bothHaveData ? competitive.winRate - casual.winRate : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Casual vs Competitive</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <p className="text-xs text-muted-foreground">
          Ignores the source filter above (time range still applies).
        </p>
        <div className="grid grid-cols-2 gap-2">
          <SplitStat label="Casual" record={casual} />
          <SplitStat label="Competitive" record={competitive} />
        </div>
        {bothHaveData && delta != null && (
          <p className="text-sm">
            <span className="text-muted-foreground">Delta: </span>
            <span
              className={`font-semibold ${delta >= 0 ? 'text-emerald-500' : 'text-destructive'}`}
            >
              {delta >= 0 ? '+' : ''}
              {delta}pts
            </span>
            <span className="text-muted-foreground"> (competitive vs casual)</span>
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function SplitStat({ label, record }: { label: string; record: WinLossRecord }) {
  if (record.total === 0) {
    return (
      <div>
        <h3 className="text-sm text-muted-foreground">{label}</h3>
        <p className="text-sm text-muted-foreground">no data</p>
      </div>
    );
  }
  return (
    <div>
      <h3 className="text-sm text-muted-foreground">{label}</h3>
      <p className="text-lg font-semibold">{record.winRate}%</p>
      <p className="text-xs text-muted-foreground">
        {record.wins}-{record.losses} ({record.total})
      </p>
    </div>
  );
}

function OnlineOfflineCard({ matches }: { matches: Match[] }) {
  const { online, offline } = getOnlineOfflineSplit(matches);
  const hasAny = online.total > 0 || offline.total > 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Online vs Offline</CardTitle>
      </CardHeader>
      <CardContent>
        {hasAny ? (
          <div className="grid grid-cols-2 gap-2">
            <SplitStat label="Online" record={online} />
            <SplitStat label="Offline" record={offline} />
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No match data to report yet.</p>
        )}
      </CardContent>
    </Card>
  );
}
