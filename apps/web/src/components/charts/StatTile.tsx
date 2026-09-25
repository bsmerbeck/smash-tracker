import type { ReactNode } from 'react';
import { StatRow, StatFigure } from '@/components/analytics/StatRow';

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
 * The sparkline/stat-tile vocabulary member (CHRT-01). Plan 39.1-20 (UIX-04):
 * a thin wrapper over the one stat idiom (`StatRow`/`StatFigure`) — the old
 * flex-based even-distribution row that could collide with a gapped grid
 * under `PageGrid`'s `items-start` is gone, removing the last §13.3-banned
 * pattern occurrence in the chart kit. Existing consumers keep their exact
 * `{ label, value }[]` + optional `trend` shape unchanged; each pair maps
 * onto one `StatFigure`. The tile still sets no minimum/fixed height of its
 * own — `ChartCard` is the frame every consumer wraps it in.
 */
export function StatTile({ stats, trend }: StatTileProps) {
  return (
    <div className="flex flex-col gap-3">
      <StatRow
        figures={stats.map((stat) => (
          <StatFigure key={stat.label} label={stat.label} value={stat.value} />
        ))}
      />
      {trend && <div>{trend}</div>}
    </div>
  );
}
