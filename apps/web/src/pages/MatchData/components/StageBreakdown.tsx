import { useMemo, useState } from 'react';
import type { Match } from '@smash-tracker/shared';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { NO_SELECTION_STAGE } from '@/data/stages';
import { getFighterById } from '@/data/sprites';
import { getStageRecords, getWinLossRecord } from '@/lib/stats';
import { getGroupedStageOptions, stageOptions } from '@/lib/stageOptions';
import { StageOption } from '@/components/StageOption';

/**
 * Ports legacy/src/screens/MatchData/components/StageBreakdown — pick a
 * stage, see the overall record for it (via `getStageRecords`) plus a
 * per-fighter breakdown for matches played on that stage.
 */
export function StageBreakdown({
  matches,
  usageMatches,
}: {
  matches: Match[];
  /** Unfiltered matches used to compute "Most played" ordering; defaults to `matches` when omitted. */
  usageMatches?: Match[];
}) {
  const [stageId, setStageId] = useState<number>(NO_SELECTION_STAGE.id);
  const { mostPlayed, all: allStages } = useMemo(
    () => getGroupedStageOptions(usageMatches ?? matches),
    [usageMatches, matches],
  );

  if (matches.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Stage Breakdown</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">No match data to report yet.</p>
        </CardContent>
      </Card>
    );
  }

  const selectedStage = stageOptions.find((s) => s.id === stageId) ?? NO_SELECTION_STAGE;
  const stageRecords = getStageRecords(matches);
  const record = stageRecords.find((r) => r.stageId === stageId);

  const stageMatches = matches.filter((m) => (m.map?.id ?? 0) === stageId);
  const fighterIds = [...new Set(stageMatches.map((m) => m.fighter_id))];
  const fighterStats = fighterIds
    .map((fid) => {
      const fighter = getFighterById(fid);
      if (!fighter) return null;
      const fighterMatches = stageMatches.filter((m) => m.fighter_id === fid);
      return { fighter, ...getWinLossRecord(fighterMatches) };
    })
    .filter((f): f is NonNullable<typeof f> => f != null);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Stage Breakdown</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <Select value={String(stageId)} onValueChange={(v) => setStageId(Number(v))}>
          <SelectTrigger className="w-full max-w-xs" aria-label="Select stage">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={String(NO_SELECTION_STAGE.id)}>{NO_SELECTION_STAGE.name}</SelectItem>
            {mostPlayed.length > 0 && (
              <SelectGroup>
                <SelectLabel>Most played</SelectLabel>
                {mostPlayed.map((s) => (
                  <SelectItem key={`most-played-${s.id}`} value={String(s.id)}>
                    <StageOption stage={s} />
                  </SelectItem>
                ))}
              </SelectGroup>
            )}
            <SelectGroup>
              <SelectLabel>All stages</SelectLabel>
              {allStages.map((s) => (
                <SelectItem key={`all-${s.id}`} value={String(s.id)}>
                  <StageOption stage={s} />
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>

        <div className="text-center">
          <h3 className="text-lg font-medium">{selectedStage.name}</h3>
          {!record || record.total === 0 ? (
            <p className="text-sm text-muted-foreground">No reported matches on this stage.</p>
          ) : (
            <div className="flex justify-evenly pt-2">
              <Stat label="Rate" value={`${record.winRate}%`} />
              <Stat label="Wins" value={record.wins} />
              <Stat label="Losses" value={record.losses} />
            </div>
          )}
        </div>

        {fighterStats.length > 0 && (
          <ul className="flex flex-col gap-2">
            {fighterStats.map(({ fighter, wins, losses, winRate }) => (
              <li key={fighter.id} className="flex items-center gap-3 rounded-md border p-2">
                <img src={fighter.url} alt="" className="size-8 object-contain" />
                <span className="flex-1 font-medium">{fighter.name}</span>
                <div className="flex gap-4 text-sm text-muted-foreground">
                  <span>{winRate}%</span>
                  <span>{wins}W</span>
                  <span>{losses}L</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex flex-col items-center text-center">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-lg font-medium">{value}</span>
    </div>
  );
}
