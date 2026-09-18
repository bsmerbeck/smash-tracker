import { useTranslation } from 'react-i18next';
import { getWinLossRecord } from '@/lib/stats';
import type { Match } from '@smash-tracker/shared';
import { ChartCard } from '@/components/charts/ChartCard';
import { StatTile } from '@/components/charts/StatTile';
import { WinLossPips } from '@/components/WinLossPips';

/**
 * Ports legacy/src/screens/Matchups/components/MatchWinLossCard — record for
 * the specific fighter-vs-opponent matchup, promoted to a framed stat tile
 * (CHRT-01, plan 37-03) inside `ChartCard`: a title, the unchanged
 * three-stat row, and the existing win/loss pips as its trend row.
 */
export function MatchWinLossCard({ matchupMatches }: { matchupMatches: Match[] }) {
  const { t } = useTranslation();

  if (matchupMatches.length === 0) {
    // A 0-0 record is a recorded fact, not a gated recommendation — the
    // abstention sentence would misdescribe it, so `abstained` is
    // deliberately NOT passed here (Phase 36 precedent). Do not "fix" this
    // into the abstention path.
    return (
      <ChartCard title={t('matchups.record.title')}>
        <p className="text-sm text-muted-foreground">{t('matchups.record.empty')}</p>
      </ChartCard>
    );
  }

  const { wins, losses, total } = getWinLossRecord(matchupMatches);

  return (
    <ChartCard title={t('matchups.record.title')}>
      <StatTile
        stats={[
          { label: t('common.wins'), value: wins },
          { label: t('matchups.record.totalMatches'), value: total },
          { label: t('common.losses'), value: losses },
        ]}
        trend={<WinLossPips matches={matchupMatches} limit={10} />}
      />
    </ChartCard>
  );
}
