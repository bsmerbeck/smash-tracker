import type { Match } from '@smash-tracker/shared';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { stageAbbreviation } from '@/components/StageOption';
import { stagesById } from '@/data/stages';
import { buildStageMasteryCaption, buildStageMasteryTiles } from '../lib/stageMastery';
import type { MasteryTintBucket, StageMasteryTile } from '../lib/stageMastery';

/** Tile tint per Wilson bucket, mirroring the Matchups matrix's red -> grey -> emerald convention (implemented locally here, not imported, per the Fighter Analysis spec). */
const TINT_CLASSES: Record<MasteryTintBucket, string> = {
  weak: 'border-destructive/50 bg-destructive/10',
  even: 'border-border bg-muted/40',
  strong: 'border-emerald-500/50 bg-emerald-500/10',
};

/**
 * Every stage with at least one recorded game for the selected fighter, as an
 * art tile grid ordered by Wilson evidence (best first), tinted by that
 * Wilson bucket. A "Best pick / Ban-worthy" caption row up top calls out the
 * standout stages (folds in the retired BestWorstMap card per
 * docs/analytics-vision.md V4 Phase E).
 *
 * `title` defaults to "Stage Mastery" (its original framing here); pass a
 * more specific title to reuse this same tile grid for a different subject,
 * e.g. the Scout page's "Full analysis" section rendering it once for a
 * scouted player's whole sample and again for just their top character.
 */
export function StageMastery({
  fighterMatches,
  title = 'Stage Mastery',
}: {
  fighterMatches: Match[];
  title?: string;
}) {
  const tiles = buildStageMasteryTiles(fighterMatches);
  const { bestPick, banWorthy } = buildStageMasteryCaption(fighterMatches);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {(bestPick || banWorthy) && (
          <div className="flex flex-wrap gap-4 text-sm">
            {bestPick && (
              <p>
                <span className="font-medium text-emerald-500">Best pick:</span>{' '}
                {stagesById.get(bestPick.stageId)?.name ?? 'Unknown'} ({bestPick.winRate}% over{' '}
                {bestPick.total})
              </p>
            )}
            {banWorthy && (
              <p>
                <span className="font-medium text-destructive">Ban-worthy:</span>{' '}
                {stagesById.get(banWorthy.stageId)?.name ?? 'Unknown'} ({banWorthy.winRate}% over{' '}
                {banWorthy.total})
              </p>
            )}
          </div>
        )}

        {tiles.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No stage data yet — report matches with this fighter to build the grid.
          </p>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
            {tiles.map((tile) => (
              <StageTile key={tile.stageId} tile={tile} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function StageTile({ tile }: { tile: StageMasteryTile }) {
  const stage = stagesById.get(tile.stageId);
  const name = stage?.name ?? 'Unknown';

  return (
    <div className={`flex flex-col overflow-hidden rounded-lg border ${TINT_CLASSES[tile.tint]}`}>
      {stage?.url ? (
        <img src={stage.url} alt="" className="h-20 w-full object-cover" loading="lazy" />
      ) : (
        <div
          className="flex h-20 w-full items-center justify-center bg-muted text-lg font-semibold text-muted-foreground"
          aria-hidden="true"
        >
          {stageAbbreviation(name)}
        </div>
      )}
      <div className="flex flex-col gap-0.5 p-2">
        <span className="truncate text-sm font-medium">{name}</span>
        <span className="text-xs text-muted-foreground">
          {tile.wins}-{tile.losses} &middot; {tile.winRate}% ({tile.total})
        </span>
      </div>
    </div>
  );
}
