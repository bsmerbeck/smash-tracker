import type { Match } from '@smash-tracker/shared';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { getFighterById } from '@/data/sprites';
import { buildMatchupCoverage } from '../lib/matchupCoverage';
import type { CoverageEntry, CoverageStatus } from '../lib/matchupCoverage';

const STATUS_CLASSES: Record<CoverageStatus, string> = {
  covered: 'border-border bg-muted/40',
  thin: 'border-amber-500/50 bg-amber-500/10',
  none: 'border-destructive/50 bg-destructive/10 opacity-75',
};

const STATUS_LABEL: Record<CoverageStatus, string> = {
  covered: '',
  thin: 'thin data',
  none: 'no data',
};

/**
 * Coverage grid for the top opponent characters the user faces across their
 * ENTIRE filtered dataset (all fighters — "the meta they actually face"),
 * annotated with the SELECTED fighter's record against each: solid data,
 * thin data (<3 games), or no data at all, each visually distinct.
 */
export function MatchupCoverage({
  allFilteredMatches,
  fighterMatches,
}: {
  allFilteredMatches: Match[];
  fighterMatches: Match[];
}) {
  const coverage = buildMatchupCoverage(allFilteredMatches, fighterMatches);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Matchup Coverage</CardTitle>
      </CardHeader>
      <CardContent>
        {coverage.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No opponent data yet — report matches to see who you actually face.
          </p>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
            {coverage.map((entry) => (
              <CoverageTile key={entry.opponentFighterId} entry={entry} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function CoverageTile({ entry }: { entry: CoverageEntry }) {
  const sprite = getFighterById(entry.opponentFighterId);
  const name = sprite?.name ?? 'Unknown';
  const statusLabel = STATUS_LABEL[entry.status];

  return (
    <div
      className={`flex flex-col items-center gap-1 rounded-lg border p-2 text-center ${STATUS_CLASSES[entry.status]}`}
    >
      {sprite?.url ? (
        <img src={sprite.url} alt="" className="size-12 object-contain" loading="lazy" />
      ) : (
        <div
          className="flex size-12 items-center justify-center rounded bg-muted text-xs text-muted-foreground"
          aria-hidden="true"
        >
          ?
        </div>
      )}
      <span className="truncate text-sm font-medium">{name}</span>
      {entry.record ? (
        <span className="text-xs text-muted-foreground">
          {entry.record.wins}-{entry.record.losses} &middot; {entry.record.winRate}%
        </span>
      ) : (
        <span className="text-xs text-muted-foreground">0 games</span>
      )}
      {statusLabel && (
        <span
          className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
            entry.status === 'none' ? 'text-destructive' : 'text-amber-600'
          }`}
        >
          {statusLabel}
        </span>
      )}
    </div>
  );
}
