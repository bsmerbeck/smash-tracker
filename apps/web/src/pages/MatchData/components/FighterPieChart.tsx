import { ArcElement, Chart as ChartJS, Legend, Tooltip, type ChartOptions } from 'chart.js';
import { Doughnut } from 'react-chartjs-2';
import type { Fighter, Match } from '@smash-tracker/shared';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { generateGradient } from '@/lib/colors';

ChartJS.register(ArcElement, Tooltip, Legend);

interface ChartSlice {
  fighter: Fighter;
  matchCount: number;
  percentage: number;
}

/**
 * Ports legacy/src/screens/MatchData/components/FighterPieChart — matches
 * per fighter distribution as a doughnut chart. Legacy's slice colors came
 * from `jsgradient.generateGradient` (a red-to-black gradient sized to the
 * fighter count); this uses the deterministic `generateGradient` port in
 * `src/lib/colors.ts` for the same effect without "random" in the name.
 */
export function FighterPieChart({
  matches,
  fighterSprites,
}: {
  matches: Match[];
  fighterSprites: Fighter[];
}) {
  if (matches.length === 0 || fighterSprites.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Fighter Breakdown</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">No match data to report yet.</p>
        </CardContent>
      </Card>
    );
  }

  const chartData: ChartSlice[] = fighterSprites
    .map((fighter) => {
      const fighterMatches = matches.filter((m) => m.fighter_id === fighter.id);
      return {
        fighter,
        matchCount: fighterMatches.length,
        percentage: Math.round((fighterMatches.length / matches.length) * 100),
      };
    })
    .sort((a, b) => b.matchCount - a.matchCount);

  const colors = generateGradient('#ff0000', '#070707', fighterSprites.length);

  const data = {
    labels: chartData.map((slice) => slice.fighter.name),
    datasets: [
      {
        data: chartData.map((slice) => slice.matchCount),
        backgroundColor: colors,
      },
    ],
  };

  const options: ChartOptions<'doughnut'> = {
    cutout: '70%',
    rotation: 180,
    plugins: {
      legend: {
        position: 'bottom',
      },
      tooltip: {
        callbacks: {
          label: (item) => {
            const slice = chartData[item.dataIndex];
            return `${item.label}: ${slice?.percentage ?? 0}% (${item.formattedValue})`;
          },
        },
      },
    },
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Fighter Breakdown</CardTitle>
      </CardHeader>
      <CardContent>
        <Doughnut data={data} options={options} />
      </CardContent>
    </Card>
  );
}
