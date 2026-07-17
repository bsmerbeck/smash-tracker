import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Download, ExternalLink } from 'lucide-react';
import type { PublicShareSnapshot } from '@smash-tracker/shared';
import { formatOrdinal } from '@smash-tracker/shared';
import { getFighterById } from '@/data/sprites';
import { PublicLayout } from '@/layouts/PublicLayout';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

/**
 * Anonymous recap detail render (RECAP-02/RECAP-03), for a `snapshot.kind
 * === 'recap'` public share — the deterministic post-tournament stats card
 * (placement, seed→finish, set record, notable win, characters,
 * reviewed-moments count, tournament name+date) with NO video player (a
 * recap snapshot has no `vodUrl`). Renders inside `ShareViewPage`'s existing
 * `/s/:token` route, AFTER its unavailable/isPending guards, so a
 * revoked/unknown recap token never reaches this component — it always
 * renders the same no-leak unavailable page as a vod-review token would.
 *
 * Reuses the same `PublicLayout` chrome and the Phase 6 low-pressure
 * "Review your own set" signup CTA card, per 07-CONTEXT.md's decision that
 * recap shares flow through the exact same pipeline/scaffolding as VOD
 * review shares — only the in-page render differs by kind.
 *
 * Walkthrough amendment (07-09): when the recap was generated with
 * `detail: 'full'`, `snapshot.sets` carries the whole chronological set
 * timeline — rendered here as its own "Set timeline" section (round label,
 * opponent tag + placement ordinal when known, game score, W/L, stage
 * chips). Opponent tags/placements/stages are PUBLIC BRACKET DATA (unlike a
 * VOD-review snapshot's opponent identity), a deliberate inclusion per
 * CONTEXT.md — never private notes. When `snapshot.tournamentUrl` is
 * present (start.gg only — parry.gg's public event-URL shape is unverified
 * and never invented), an outbound "View bracket on {site}" button links to
 * the source event page; absent entirely when no trustworthy URL exists.
 */
export function RecapView({ snapshot, token }: { snapshot: PublicShareSnapshot; token: string }) {
  const { t } = useTranslation();

  const placement = snapshot.placement ?? null;
  const seed = snapshot.seed ?? null;
  const hasNotableWin = snapshot.notableWinOpponentSeed != null;
  const characters = (snapshot.characterFighterIds ?? [])
    .map((id) => getFighterById(id))
    .filter((fighter): fighter is NonNullable<typeof fighter> => Boolean(fighter));
  const sets = snapshot.sets ?? [];

  return (
    <PublicLayout>
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-8">
        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
            {t('share.recap.heading')}
          </span>
          <h1 className="text-2xl font-semibold tracking-tight">{snapshot.tournamentName}</h1>
          {snapshot.tournamentDate != null && (
            <span className="text-sm text-muted-foreground">
              {new Date(snapshot.tournamentDate).toLocaleDateString()}
            </span>
          )}
          {snapshot.ownerDisplayName && (
            <p className="text-sm text-muted-foreground">
              {t('share.sharedBy', { name: snapshot.ownerDisplayName })}
            </p>
          )}
        </div>

        <div className="flex flex-col gap-3 rounded-lg border p-4">
          <div className="flex flex-wrap items-center gap-2">
            {seed != null && placement != null ? (
              <Badge variant="default" className="text-sm">
                {t('share.recap.seedToFinish', { seed, placement: formatOrdinal(placement) })}
              </Badge>
            ) : placement != null ? (
              <Badge variant="default" className="text-sm">
                {t('share.recap.placement', { placement: formatOrdinal(placement) })}
              </Badge>
            ) : null}
            <Badge variant="secondary" className="text-sm">
              {t('share.recap.setRecord', {
                wins: snapshot.setRecordWins,
                losses: snapshot.setRecordLosses,
              })}
            </Badge>
          </div>

          {hasNotableWin && (
            <p className="text-sm text-muted-foreground">
              {snapshot.notableWinOpponentName
                ? t('share.recap.notableWinNamed', { name: snapshot.notableWinOpponentName })
                : t('share.recap.notableWinSeed', { seed: snapshot.notableWinOpponentSeed })}
            </p>
          )}

          {characters.length > 0 && (
            <div className="flex flex-wrap gap-2" aria-label={t('share.recap.charactersLabel')}>
              {characters.map((fighter) => (
                <img
                  key={fighter.id}
                  src={fighter.url}
                  alt={fighter.name}
                  className="size-10 shrink-0 rounded"
                />
              ))}
            </div>
          )}

          {snapshot.reviewedMomentsCount > 0 && (
            <p className="text-sm font-medium">
              {t('share.recap.reviewedMoments', { count: snapshot.reviewedMomentsCount })}
            </p>
          )}
        </div>

        {sets.length > 0 && (
          <div className="flex flex-col gap-3 rounded-lg border p-4">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              {t('share.recap.setTimelineHeading')}
            </h2>
            <div className="flex flex-col gap-3">
              {sets.map((set, index) => (
                <div
                  key={index}
                  className="flex flex-col gap-2 border-b pb-3 last:border-0 last:pb-0"
                >
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <Badge variant={set.win ? 'success' : 'destructive'}>
                      {set.win ? t('share.resultWin') : t('share.resultLoss')}
                    </Badge>
                    <span className="font-medium">{set.roundLabel}</span>
                    <span className="text-muted-foreground">
                      {set.opponentPlacement != null
                        ? t('share.recap.opponentWithPlacement', {
                            name: set.opponentName,
                            placement: formatOrdinal(set.opponentPlacement),
                          })
                        : set.opponentName}
                    </span>
                    <span className="text-muted-foreground">
                      {t('share.recap.setScoreLabel', { wins: set.wins, losses: set.losses })}
                    </span>
                  </div>
                  {set.stages && set.stages.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {set.stages.map((stage) => (
                        <Badge key={stage} variant="outline" className="text-xs">
                          {stage}
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          {snapshot.tournamentUrl && (
            <Button asChild variant="outline" className="w-fit gap-1.5">
              <a href={snapshot.tournamentUrl} target="_blank" rel="noreferrer">
                {snapshot.recapSource === 'parrygg'
                  ? t('share.recap.viewBracketParrygg')
                  : t('share.recap.viewBracketStartgg')}
                <ExternalLink className="size-4" />
              </a>
            </Button>
          )}
          <Button asChild variant="outline" className="w-fit gap-1.5">
            <a href={`/s/${token}/og.png`} download>
              <Download className="size-4" />
              {t('share.recap.download')}
            </a>
          </Button>
        </div>

        <div className="rounded-lg border bg-muted/40 p-4 text-center">
          <p className="font-medium">{t('share.ctaTitle')}</p>
          <p className="mt-1 text-sm text-muted-foreground">{t('share.ctaBody')}</p>
          <Button asChild className="mt-3">
            <Link to="/">{t('share.ctaButton')}</Link>
          </Button>
        </div>
      </div>
    </PublicLayout>
  );
}
