import { useTranslation } from 'react-i18next';
import {
  CategoryScale,
  Chart as ChartJS,
  Legend,
  LineElement,
  LinearScale,
  PointElement,
  Tooltip,
} from 'chart.js';
import { Line } from 'react-chartjs-2';
import type { Fighter, Match } from '@smash-tracker/shared';
import { Card, CardContent } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { WinLossPips } from '@/components/WinLossPips';
import { getMatchTypeRecords } from '@/lib/stats';
import { darkChartOptions, redLineDataset } from '@/lib/chartTheme';
import { buildFighterHero } from '../lib/fighterHero';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Legend);

/**
 * The Fighter Analysis command center's hero region: sprite + name, overall
 * record, last-10 form pips, current streak chip, this fighter's share of
 * the user's total games, a compact rolling win-rate sparkline, and a
 * by-match-type table (folds in the retired StreakCard + PerformanceSnapshot
 * content per docs/analytics-vision.md V4 Phase E).
 */
export function FighterHero({
  fighter,
  fighterMatches,
  allMatches,
}: {
  fighter: Fighter;
  fighterMatches: Match[];
  allMatches: Match[];
}) {
  const { t } = useTranslation();
  const { record, sharePct, streak, sparkline } = buildFighterHero(fighterMatches, allMatches);
  const typeRecords = getMatchTypeRecords(fighterMatches);
  const hasMatches = record.total > 0;

  return (
    <Card>
      <CardContent className="flex flex-col gap-6 lg:flex-row lg:items-start">
        <div className="flex flex-col items-center gap-3 text-center lg:items-start lg:text-left">
          <img src={fighter.url} alt="" className="size-32 object-contain" />
          <h2 className="text-3xl font-bold tracking-tight">{fighter.name}</h2>
        </div>

        <div className="flex flex-1 flex-col gap-4">
          <div className="flex flex-wrap items-center gap-4">
            {hasMatches ? (
              <div>
                <span className="text-3xl font-bold" data-testid="hero-record">
                  {record.wins}-{record.losses}
                </span>
                <p className="text-sm text-muted-foreground">
                  {t('fighterAnalysis.hero.rateAndGames', {
                    rate: record.winRate,
                    count: record.total,
                  })}
                </p>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">{t('fighterAnalysis.hero.noMatches')}</p>
            )}

            {hasMatches && (
              <span
                className={`w-fit rounded-full px-2 py-0.5 text-sm font-semibold ${
                  streak.isWin
                    ? 'bg-emerald-500/15 text-emerald-500'
                    : 'bg-destructive/15 text-destructive'
                }`}
              >
                {streak.isWin
                  ? t('fighterAnalysis.hero.streakWin', { count: streak.count })
                  : t('fighterAnalysis.hero.streakLoss', { count: streak.count })}
              </span>
            )}

            {hasMatches && (
              <span className="text-sm text-muted-foreground">
                {t('fighterAnalysis.hero.share', { pct: sharePct })}
              </span>
            )}
          </div>

          {hasMatches && (
            <div>
              <h3 className="mb-2 text-sm font-medium text-muted-foreground">
                {t('fighterAnalysis.hero.last10')}
              </h3>
              <WinLossPips matches={fighterMatches} limit={10} />
            </div>
          )}

          {sparkline.length > 1 && (
            <div className="h-24">
              <h3 className="mb-1 text-sm font-medium text-muted-foreground">
                {t('fighterAnalysis.hero.formRolling')}
              </h3>
              <div className="h-16">
                <Line
                  data={{
                    labels: sparkline.map((p) => p.index.toString()),
                    datasets: [
                      {
                        ...redLineDataset(),
                        pointRadius: 0,
                        pointHoverRadius: 3,
                        data: sparkline.map((p) => p.winRate),
                      },
                    ],
                  }}
                  options={sparklineOptions()}
                />
              </div>
            </div>
          )}
        </div>

        <div className="w-full lg:w-72">
          <h3 className="mb-2 text-sm font-medium text-muted-foreground">
            {t('matchups.insights.byMatchType')}
          </h3>
          {typeRecords.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('shared.pips.empty')}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('fighterAnalysis.hero.typeColumn')}</TableHead>
                  <TableHead>{t('matchups.stageTable.record')}</TableHead>
                  <TableHead>{t('common.rate')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {typeRecords.map((record) => (
                  <TableRow key={record.matchType}>
                    <TableCell>{record.matchType}</TableCell>
                    <TableCell>
                      {record.wins}-{record.losses}
                    </TableCell>
                    <TableCell>{record.winRate}%</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function sparklineOptions() {
  const theme = darkChartOptions();
  return {
    responsive: true,
    maintainAspectRatio: false,
    scales: {
      x: { ...theme.scales?.x, display: false },
      y: { ...theme.scales?.y, display: false, min: 0, max: 100 },
    },
    plugins: {
      legend: { display: false },
      tooltip: {
        ...theme.plugins?.tooltip,
        callbacks: {
          label: (item: { formattedValue: string }) =>
            `${Math.round(Number(item.formattedValue) * 100) / 100}%`,
        },
      },
    },
  };
}
