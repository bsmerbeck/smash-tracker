import { Link, useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { useMatches } from '@/hooks/useMatches';
import { useFighters } from '@/hooks/useFighters';
import { useCoachingClients } from '@/hooks/useCoachingClients';
import { getFighterById } from '@/data/sprites';
import { getLastNMatches, getWinLossRecord } from '@/lib/stats';

/** FB-7: the Overview's recent-matches mini-list shows the last N by date. */
const RECENT_MATCHES_LIMIT = 5;

interface ChecklistStepConfig {
  key: 'fighters' | 'matches' | 'vod';
  done: boolean;
  href: string;
  titleKey: string;
  description: string;
  buttonLabel: string;
}

/**
 * Phase 11 fix round 2 (D-02/D2): the `/coach/:clientId` landing page. Three
 * stat cards (Matches / VODs / Win rate — '—' when the client has zero
 * matches) followed by a three-step setup checklist whose done-state is
 * derived purely from the subject-scoped `useMatches`/`useFighters` reads
 * (PAR-04 — never a personal-only source). Exactly one row — the FIRST
 * incomplete one — gets the coaching-accent button so there is always a
 * single, unambiguous next action.
 *
 * Fix round 3 (FB-7): enrichment between the stat cards and the checklist —
 * a Fighters card (primary/secondary sprites, reusing `getFighterById` from
 * `@/data/sprites` rather than duplicating sprite assets) and a
 * recent-matches mini-list (last 5 by date, reusing `getLastNMatches` and
 * the win/loss `Badge` styling MatchTable already established).
 */
export function ClientOverviewPage() {
  const { t } = useTranslation();
  const { clientId = '' } = useParams<{ clientId: string }>();
  const clients = useCoachingClients();
  const clientLabel =
    clients.data?.find((client) => client.clientId === clientId)?.label ?? clientId;

  const { data: matchesData } = useMatches();
  const { data: fighters } = useFighters();
  const matches = matchesData ?? [];
  const matchCount = matches.length;
  const vodCount = matches.filter((match) => match.vodUrl != null).length;
  const record = getWinLossRecord(matches);
  const winRateLabel =
    matchCount === 0 ? t('coaching.overview.winRateEmpty') : `${record.winRate}%`;

  const fightersDone = (fighters?.primary?.length ?? 0) > 0;
  const matchesDone = matchCount >= 1;
  const vodDone = vodCount >= 1;

  const primarySprites = (fighters?.primary ?? [])
    .map((id) => getFighterById(id))
    .filter((sprite): sprite is NonNullable<typeof sprite> => sprite != null);
  const secondarySprites = (fighters?.secondary ?? [])
    .map((id) => getFighterById(id))
    .filter((sprite): sprite is NonNullable<typeof sprite> => sprite != null);
  const recentMatches = getLastNMatches(matches, RECENT_MATCHES_LIMIT);

  const steps: ChecklistStepConfig[] = [
    {
      key: 'fighters',
      done: fightersDone,
      href: '../fighters',
      titleKey: 'coaching.overview.checklist.fighters.title',
      description: t('coaching.overview.checklist.fighters.description'),
      buttonLabel: t('coaching.overview.checklist.fighters.editButton'),
    },
    {
      key: 'matches',
      done: matchesDone,
      href: '../match-data',
      titleKey: 'coaching.overview.checklist.matches.title',
      description: t('coaching.overview.checklist.matches.description', { count: matchCount }),
      buttonLabel: matchesDone
        ? t('coaching.overview.checklist.matches.addMoreButton')
        : t('coaching.overview.checklist.matches.addButton'),
    },
    {
      key: 'vod',
      done: vodDone,
      href: '../vods',
      titleKey: 'coaching.overview.checklist.vod.title',
      description: t('coaching.overview.checklist.vod.description'),
      buttonLabel: t('coaching.overview.checklist.vod.attachButton'),
    },
  ];

  const firstIncompleteIndex = steps.findIndex((step) => !step.done);
  // Phase 11 fix round 3 (FB-8): once every step is done, the tutorial
  // checklist never shows again — it's replaced by a compact "Quick
  // actions" row so a returning coach isn't stuck looking at three
  // permanently-checked rows.
  const allStepsDone = firstIncompleteIndex === -1;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          {clientLabel} — {t('coaching.overview.title')}
        </h1>
        <p className="text-sm text-muted-foreground">{t('coaching.overview.subtitle')}</p>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Card>
          <CardContent className="py-0">
            <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              {t('coaching.overview.cards.matches')}
            </p>
            <p className="mt-1 text-2xl font-bold tabular-nums">{matchCount}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-0">
            <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              {t('coaching.overview.cards.vods')}
            </p>
            <p className="mt-1 text-2xl font-bold tabular-nums">{vodCount}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-0">
            <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              {t('coaching.overview.cards.winRate')}
            </p>
            <p className="mt-1 text-2xl font-bold tabular-nums">{winRateLabel}</p>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{t('coaching.overview.fightersTitle')}</CardTitle>
          </CardHeader>
          <CardContent>
            {primarySprites.length === 0 && secondarySprites.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {t('coaching.overview.fightersCard.empty')}
              </p>
            ) : (
              <div className="flex flex-wrap gap-6">
                <FighterSpriteGroup
                  label={t('coaching.overview.fightersCard.primary')}
                  sprites={primarySprites}
                />
                <FighterSpriteGroup
                  label={t('coaching.overview.fightersCard.secondary')}
                  sprites={secondarySprites}
                />
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t('coaching.overview.recentMatches.title')}</CardTitle>
          </CardHeader>
          <CardContent>
            {recentMatches.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {t('coaching.overview.recentMatches.empty')}
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {recentMatches.map((match) => {
                  const fighterSprite = getFighterById(match.fighter_id);
                  const opponentSprite = getFighterById(match.opponent_id);
                  return (
                    <li
                      key={match.id}
                      className="flex items-center justify-between gap-3 rounded-md border p-2"
                    >
                      <div className="flex items-center gap-3">
                        <span className="w-20 shrink-0 text-xs text-muted-foreground">
                          {new Date(match.time).toLocaleDateString()}
                        </span>
                        <span className="flex items-center gap-1">
                          {fighterSprite && (
                            <img
                              src={fighterSprite.url}
                              alt={fighterSprite.name}
                              className="size-6 object-contain"
                            />
                          )}
                          <span className="text-muted-foreground">vs</span>
                          {opponentSprite && (
                            <img
                              src={opponentSprite.url}
                              alt={opponentSprite.name}
                              className="size-6 object-contain"
                            />
                          )}
                        </span>
                        <span className="text-sm font-medium">
                          {match.opponent || t('common.unknown')}
                        </span>
                      </div>
                      <Badge variant={match.win ? 'success' : 'destructive'}>
                        {match.win ? t('common.win') : t('common.loss')}
                      </Badge>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      {allStepsDone ? (
        <div data-testid="quick-actions" className="flex flex-col gap-2">
          <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            {t('coaching.overview.quickActions.title')}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="outline">
              <Link to="../match-data">{t('coaching.overview.quickActions.addMatch')}</Link>
            </Button>
            <Button asChild variant="outline">
              <Link to="../vods">{t('coaching.overview.quickActions.attachVod')}</Link>
            </Button>
            <Button asChild variant="outline">
              <Link to="../dashboard">{t('coaching.overview.quickActions.openAnalytics')}</Link>
            </Button>
          </div>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border">
          {steps.map((step, index) => (
            <div
              key={step.key}
              data-testid={`checklist-${step.key}`}
              data-done={step.done}
              className={cn('flex items-center gap-3 px-4 py-3', index > 0 && 'border-t')}
            >
              <span
                aria-hidden="true"
                className={cn(
                  'flex size-6 shrink-0 items-center justify-center rounded-full border text-xs',
                  step.done ? 'border-emerald-500 text-emerald-500' : 'text-muted-foreground',
                )}
              >
                {step.done ? <Check className="size-3.5" /> : index + 1}
              </span>
              <div className="flex-1">
                <p className="font-medium">{t(step.titleKey)}</p>
                <p className="text-sm text-muted-foreground">{step.description}</p>
              </div>
              <Button
                asChild
                variant={index === firstIncompleteIndex ? 'default' : 'outline'}
                className={
                  index === firstIncompleteIndex
                    ? 'bg-coaching-accent text-coaching-accent-foreground hover:bg-coaching-accent/90'
                    : undefined
                }
              >
                <Link to={step.href}>{step.buttonLabel}</Link>
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** FB-7: a labeled row of fighter sprites (Fighters card's primary/secondary groups). */
function FighterSpriteGroup({
  label,
  sprites,
}: {
  label: string;
  sprites: NonNullable<ReturnType<typeof getFighterById>>[];
}) {
  if (sprites.length === 0) {
    return null;
  }
  return (
    <div>
      <p className="mb-1 text-xs text-muted-foreground">{label}</p>
      <div className="flex flex-wrap gap-3">
        {sprites.map((sprite) => (
          <div key={sprite.id} className="flex flex-col items-center text-center">
            <img src={sprite.url} alt="" className="size-10 object-contain" />
            <span className="text-xs">{sprite.name}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
