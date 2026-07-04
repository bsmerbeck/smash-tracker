import { useMemo, useState } from 'react';
import type { Fighter, Match } from '@smash-tracker/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { buildRosterUsage, winRateTone, type RosterUsageRow } from '../lib/rosterUsage';

const VISIBLE_CAP = 10;

/** Cycles through the theme's 5 chart tokens (index.css `--chart-1..5`) for usage bar fills — no red-to-black gradient, just the existing design-system palette. */
const BAR_COLOR_CLASSES = [
  'bg-chart-1',
  'bg-chart-2',
  'bg-chart-3',
  'bg-chart-4',
  'bg-chart-5',
] as const;

const CHIP_CLASSES: Record<ReturnType<typeof winRateTone>, string> = {
  positive: 'bg-emerald-500/15 text-emerald-500',
  neutral: 'bg-muted text-muted-foreground',
  negative: 'bg-destructive/15 text-destructive',
};

/**
 * Replaces FighterPieChart per user feedback ("huge and doesn't give much
 * insight... color scheme is frankly crap"): a compact horizontal bar list,
 * one row per fighter actually played, ordered by usage. Bar fill colors
 * cycle through the theme's `--chart-*` tokens instead of a red-to-black
 * gradient. Capped at `VISIBLE_CAP` rows with a "show all" expander for
 * larger rosters.
 */
export function RosterUsage({
  matches,
  fighterSprites,
}: {
  matches: Match[];
  fighterSprites: Fighter[];
}) {
  const [expanded, setExpanded] = useState(false);

  const rows = useMemo(() => buildRosterUsage(matches, fighterSprites), [matches, fighterSprites]);

  if (rows.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Roster Usage</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">No match data to report yet.</p>
        </CardContent>
      </Card>
    );
  }

  const visibleRows = expanded ? rows : rows.slice(0, VISIBLE_CAP);
  const hiddenCount = rows.length - visibleRows.length;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Roster Usage</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <ul className="flex flex-col gap-2">
          {visibleRows.map((row, i) => (
            <RosterUsageItem key={row.fighter.id} row={row} colorIndex={i} />
          ))}
        </ul>

        {hiddenCount > 0 && (
          <Button
            variant="outline"
            size="sm"
            className="self-start"
            onClick={() => setExpanded(true)}
          >
            Show all ({hiddenCount} more)
          </Button>
        )}
        {expanded && rows.length > VISIBLE_CAP && (
          <Button
            variant="ghost"
            size="sm"
            className="self-start"
            onClick={() => setExpanded(false)}
          >
            Show less
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

function RosterUsageItem({ row, colorIndex }: { row: RosterUsageRow; colorIndex: number }) {
  const { fighter, games, usagePercent, wins, losses, winRate } = row;
  const tone = winRateTone(winRate);
  const barColor = BAR_COLOR_CLASSES[colorIndex % BAR_COLOR_CLASSES.length];

  return (
    <li className="flex items-center gap-3">
      <img src={fighter.url} alt="" className="size-8 shrink-0 object-contain" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-sm font-medium">{fighter.name}</span>
          <span className="shrink-0 text-xs text-muted-foreground">{games} games</span>
        </div>
        <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
          <div
            className={cn('h-full rounded-full', barColor)}
            style={{ width: `${Math.max(usagePercent, 2)}%` }}
          />
        </div>
      </div>
      <span
        className={cn(
          'shrink-0 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold',
          CHIP_CLASSES[tone],
        )}
      >
        {wins}-{losses} · {winRate}% ({games})
      </span>
    </li>
  );
}
