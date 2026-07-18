import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Download, ExternalLink } from 'lucide-react';
import type { PublicShareSnapshot, RecapGame } from '@smash-tracker/shared';
import { formatOrdinal } from '@smash-tracker/shared';
import { getFighterById } from '@/data/sprites';
import { PublicLayout } from '@/layouts/PublicLayout';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * Walkthrough amendment round 2 (07-10): one game's character matchup +
 * stage within a set's timeline — sprite pair (mine vs opponent's) and a
 * stage-name chip, with a subtle per-game W/L tint (border/background),
 * mirroring the owner-facing `SetTimeline.tsx`'s `FighterTags` sprite
 * rendering convention. Renders nothing for a field it can't resolve
 * (unmapped fighter id, missing stage) rather than a broken image or blank
 * chip — a per-game record is never guaranteed complete (07-CONTEXT.md
 * "graceful omission" rule, same as the set-level fields above).
 */
function GameDetail({ game }: { game: RecapGame }) {
  const { t } = useTranslation();
  const myFighter = game.fighterId != null ? getFighterById(game.fighterId) : undefined;
  const opponentFighter =
    game.opponentFighterId != null ? getFighterById(game.opponentFighterId) : undefined;

  return (
    <div
      className={cn(
        'flex items-center gap-1.5 rounded border px-1.5 py-1 text-xs',
        game.win === true && 'border-emerald-600/40 bg-emerald-600/5',
        game.win === false && 'border-destructive/40 bg-destructive/5',
      )}
    >
      {myFighter && (
        <img
          src={myFighter.url}
          alt={myFighter.name}
          title={myFighter.name}
          className="size-6 shrink-0 object-contain"
        />
      )}
      {(myFighter || opponentFighter) && (
        <span className="text-muted-foreground">{t('matchups.vs')}</span>
      )}
      {opponentFighter && (
        <img
          src={opponentFighter.url}
          alt={opponentFighter.name}
          title={opponentFighter.name}
          className="size-6 shrink-0 object-contain"
        />
      )}
      {game.stageName && <span className="text-muted-foreground">{game.stageName}</span>}
    </div>
  );
}

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
 *
 * Walkthrough amendment round 2 (07-10): when a set carries `games`
 * (per-game character+stage detail), each set row renders a `GameDetail`
 * strip per game — sprite pair (mine vs opponent's) + stage chip + a subtle
 * per-game W/L tint — REPLACING the old set-level `stages` badge row, which
 * only shows for a pre-07-10 snapshot whose sets have no `games` at all
 * (backward compatible, never both at once).
 *
 * Walkthrough round 3 (07-11): when a set carries `opponentUrl` (start.gg or
 * parry.gg), the opponent tag becomes an outbound profile link (small
 * `ExternalLink` icon, mirroring the owner-facing `SetTimeline.tsx`'s
 * `OpponentLabel` convention exactly); when it carries `setUrl` (start.gg
 * only — parry.gg sets are never URL-addressable), the round label gains a
 * matching outbound link to the set's own page. Both are absent entirely
 * (no dead/malformed affordance rendered) whenever the backing field isn't
 * on record.
 *
 * Quick task 260718-i0q: the tournament TITLE gains the same trailing
 * outbound link from `snapshot.tournamentUrl` (aria sourced by
 * `recapSource`, hidden when absent) — distinct from, and additive to, the
 * bottom "View bracket on {site}" button below, which is unchanged.
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
          <h1 className="inline-flex items-center gap-1.5 text-2xl font-semibold tracking-tight">
            {snapshot.tournamentName}
            {snapshot.tournamentUrl && (
              <a
                href={snapshot.tournamentUrl}
                target="_blank"
                rel="noreferrer"
                aria-label={t(
                  snapshot.recapSource === 'parrygg'
                    ? 'share.recap.viewTournamentParrygg'
                    : 'share.recap.viewTournamentStartgg',
                  { name: snapshot.tournamentName },
                )}
                className="inline-flex text-muted-foreground hover:text-foreground"
              >
                <ExternalLink className="size-4" />
              </a>
            )}
          </h1>
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
                    <span className="inline-flex items-center gap-1 font-medium">
                      {set.roundLabel}
                      {set.setUrl && (
                        <a
                          href={set.setUrl}
                          target="_blank"
                          rel="noreferrer"
                          aria-label={t('share.recap.viewSetAria', { round: set.roundLabel })}
                          className="inline-flex text-muted-foreground hover:text-foreground"
                        >
                          <ExternalLink className="size-3" />
                        </a>
                      )}
                    </span>
                    <span className="inline-flex items-center gap-1 text-muted-foreground">
                      {set.opponentPlacement != null
                        ? t('share.recap.opponentWithPlacement', {
                            name: set.opponentName,
                            placement: formatOrdinal(set.opponentPlacement),
                          })
                        : set.opponentName}
                      {set.opponentUrl && (
                        <a
                          href={set.opponentUrl}
                          target="_blank"
                          rel="noreferrer"
                          aria-label={
                            snapshot.recapSource === 'parrygg'
                              ? t('share.recap.viewOpponentParrygg', { name: set.opponentName })
                              : t('share.recap.viewOpponentStartgg', { name: set.opponentName })
                          }
                          className="inline-flex text-muted-foreground hover:text-foreground"
                        >
                          <ExternalLink className="size-3" />
                        </a>
                      )}
                    </span>
                    <span className="text-muted-foreground">
                      {t('share.recap.setScoreLabel', { wins: set.wins, losses: set.losses })}
                    </span>
                  </div>
                  {set.games && set.games.length > 0 ? (
                    <div
                      className="flex flex-wrap gap-1.5"
                      aria-label={t('share.recap.gameDetailLabel')}
                    >
                      {set.games.map((game, gameIndex) => (
                        <GameDetail key={gameIndex} game={game} />
                      ))}
                    </div>
                  ) : (
                    set.stages &&
                    set.stages.length > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {set.stages.map((stage) => (
                          <Badge key={stage} variant="outline" className="text-xs">
                            {stage}
                          </Badge>
                        ))}
                      </div>
                    )
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
