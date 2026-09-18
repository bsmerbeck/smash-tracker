import type { ReactNode } from 'react';

export interface StatTileStat {
  label: string;
  value: string | number;
}

export interface StatTileProps {
  stats: StatTileStat[];
  /** Rendered beneath the stats row when present — e.g. a `WinLossPips` recent-form strip. */
  trend?: ReactNode;
}

/**
 * The sparkline/stat-tile vocabulary member (CHRT-01): a small row of
 * label/value stats with an optional trend node underneath. This is the fix
 * for the grid-stretch defect, not a restyle: the tile has INTRINSIC height
 * only — it sets no minimum height and must never be given a chart-sized
 * fixed height, because a forced height here would reintroduce the exact
 * "sparse card stretched to its neighbour's height" problem this member
 * exists to remove (a stat tile's job is to be small). It reads no design
 * tokens beyond the existing typography classes and renders no frame of its
 * own — `ChartCard` is the frame every consumer wraps it in.
 */
export function StatTile({ stats, trend }: StatTileProps) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex justify-evenly">
        {stats.map((stat) => (
          <div key={stat.label} className="flex flex-col items-center text-center">
            <span className="text-sm text-muted-foreground">{stat.label}</span>
            <span className="text-lg font-medium">{stat.value}</span>
          </div>
        ))}
      </div>
      {trend && <div>{trend}</div>}
    </div>
  );
}
