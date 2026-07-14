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
 *
 * V13: a `'combined'` identity spans BOTH sites, so it renders BOTH profile
 * links and a combined sample caption. Each link is only shown when its id
 * field is present.
 */
export function ScoutReportHeader({ report }: { report: ScoutReportData }) {
  const { t } = useTranslation();
  const source = report.player.source ?? 'startgg';

  const startggUrl = report.player.userSlug ? `https://start.gg/${report.player.userSlug}` : null;
  const parryUrl = report.player.parryUserId
    ? `https://parry.gg/profile/${report.player.parryUserId}`
    : null;

  // Which profile link(s) to show, in display order, each with its site label.
  const profileLinks: Array<{ url: string; label: string }> = [];
  if (source === 'combined') {
    if (startggUrl) profileLinks.push({ url: startggUrl, label: 'start.gg' });
    if (parryUrl) profileLinks.push({ url: parryUrl, label: 'parry.gg' });
  } else if (source === 'parrygg') {
    if (parryUrl) profileLinks.push({ url: parryUrl, label: 'parry.gg' });
  } else if (startggUrl) {
    profileLinks.push({ url: startggUrl, label: 'start.gg' });
  }

  const sampleText =
    source === 'combined'
      ? t('scout.header.sampleCombined', {
          sets: report.sampledSets,
          games: report.sampledGames,
        })
      : t('scout.header.sample', {
          source: source === 'parrygg' ? 'parry.gg' : 'start.gg',
          sets: report.sampledSets,
          games: report.sampledGames,
        });

  return (
    <Card>
      <CardContent className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-2xl font-semibold tracking-tight">{report.player.gamerTag}</h2>
          {profileLinks.map((link) => (
            <a
              key={link.label}
              href={link.url}
              target="_blank"
              rel="noreferrer"
              aria-label={t('scout.header.viewOn', {
                name: report.player.gamerTag,
                source: link.label,
              })}
              className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
            >
              <ExternalLink className="size-3.5" />
              {t('scout.header.profile', { source: link.label })}
            </a>
          ))}
        </div>
        <p className="text-sm text-muted-foreground">{sampleText}</p>
      </CardContent>
    </Card>
  );
}
