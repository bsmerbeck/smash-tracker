import { useTranslation } from 'react-i18next';
import { ExternalLink } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import type { ScoutReportData } from '@smash-tracker/shared';

/**
 * Report header: the scouted player's gamer tag, a profile link (when
 * available), and the sample-size caption every scouting report carries —
 * "this is public data, and it's a sample, not their whole history."
 *
 * V9-B Feature 4: source-aware — `report.player.source` is absent for every
 * pre-V9-B report (start.gg was the only source), so `?? 'startgg'` keeps
 * old reports labeled/linked exactly as before. parry.gg identities have no
 * `userSlug` (that field is start.gg-only), so their profile link is built
 * from `parryUserId` instead — the verified `https://parry.gg/profile/{id}`
 * shape (see apps/api/src/parrygg/scout.ts).
 */
export function ScoutReportHeader({ report }: { report: ScoutReportData }) {
  const { t } = useTranslation();
  const source = report.player.source ?? 'startgg';
  const profileUrl =
    source === 'parrygg'
      ? report.player.parryUserId
        ? `https://parry.gg/profile/${report.player.parryUserId}`
        : null
      : report.player.userSlug
        ? `https://start.gg/${report.player.userSlug}`
        : null;
  const sourceLabel = source === 'parrygg' ? 'parry.gg' : 'start.gg';

  return (
    <Card>
      <CardContent className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-2xl font-semibold tracking-tight">{report.player.gamerTag}</h2>
          {profileUrl && (
            <a
              href={profileUrl}
              target="_blank"
              rel="noreferrer"
              aria-label={t('scout.header.viewOn', {
                name: report.player.gamerTag,
                source: sourceLabel,
              })}
              className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
            >
              <ExternalLink className="size-3.5" />
              {t('scout.header.profile', { source: sourceLabel })}
            </a>
          )}
        </div>
        <p className="text-sm text-muted-foreground">
          {t('scout.header.sample', {
            source: sourceLabel,
            sets: report.sampledSets,
            games: report.sampledGames,
          })}
        </p>
      </CardContent>
    </Card>
  );
}
