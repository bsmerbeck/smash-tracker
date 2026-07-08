import { useTranslation } from 'react-i18next';
import type { Match } from '@smash-tracker/shared';
import { getLastNMatches } from '@/lib/stats';

/**
 * Recent-form strip: one dot per match (newest first), green for a win,
 * red for a loss. Shared by the Fighter Analysis and Matchups pages.
 */
export function WinLossPips({ matches, limit = 10 }: { matches: Match[]; limit?: number }) {
  const { t } = useTranslation();
  const recent = getLastNMatches(matches, limit);

  if (recent.length === 0) {
    return <p className="text-sm text-muted-foreground">{t('shared.pips.empty')}</p>;
  }

  return (
    <div
      className="flex items-center gap-1.5"
      aria-label={t('shared.pips.recentResults', { count: recent.length })}
    >
      {recent.map((match) => (
        <span
          key={match.id}
          title={`${match.win ? t('common.win') : t('common.loss')} — ${new Date(match.time).toLocaleDateString()}`}
          className={`size-3 rounded-full ${match.win ? 'bg-emerald-500' : 'bg-destructive'}`}
        />
      ))}
    </div>
  );
}
