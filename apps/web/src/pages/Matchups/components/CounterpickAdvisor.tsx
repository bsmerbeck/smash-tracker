import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { StageOption } from '@/components/StageOption';
import type { Match } from '@smash-tracker/shared';
import { buildStageEvidence, type RankedStage } from '@/lib/stats';
import { stagesById } from '@/data/stages';
import { useMinStageMatches } from '@/hooks/useMinStageMatches';

const PICK_BAN_COUNT = 3;

/**
 * Stage counterpick advisor for the selected pairing: the top 3
 * evidence-ranked stages ("Pick these") and the bottom 3 ("Ban/avoid
 * these"), each shown with its stage art, record, rate, and sample size.
 * Only stages with at least the shared per-subject minimum (Phase 35-03,
 * D-11 — `useMinStageMatches`, the same value Matchup Insights and Matchup
 * Stage Guide expose through their own selects) recorded matches in this
 * pairing qualify — and Phase 36's `buildStageEvidence` additionally floors
 * that minimum at `ABSTENTION_FLOOR_GAMES` (D-05, D-07, R1-HIGH-1) inside
 * the engine itself, so a persisted value below the floor cannot reopen a
 * below-floor row here. When nothing clears the floor, the abstained
 * sentence names exactly how many more games are needed instead of showing
 * a misleading recommendation. This component reads the threshold silently
 * — no selector of its own (D-11, planner decision 1) — so moving it in
 * Matchup Insights on the same page moves this component's picks/bans too.
 */
export function CounterpickAdvisor({ matchupMatches }: { matchupMatches: Match[] }) {
  const { t } = useTranslation();
  const [minGames] = useMinStageMatches();
  // React Compiler forbids a bare `Date.now()` call in the render body (it's
  // impure) — a lazy `useState` initializer is the sanctioned one-time-read
  // escape hatch; a stale `refreshedAt` across re-renders is harmless since
  // it's provenance metadata on the claim, not part of the ranking math.
  const [refreshedAt] = useState(() => Date.now());
  const { claim } = buildStageEvidence({
    matches: matchupMatches,
    refreshedAt,
    minMatches: minGames,
  });
  const ranked = claim.kind === 'evidenced' ? claim.value : [];
  const picks = ranked.slice(0, PICK_BAN_COUNT);
  // Bottom N, worst-first: take the tail (never overlapping the picks
  // already claimed above) and reverse it into worst-to-better order.
  const banCount = Math.min(PICK_BAN_COUNT, ranked.length - picks.length);
  const bans = banCount > 0 ? ranked.slice(ranked.length - banCount).reverse() : [];
  const sampleCueText =
    claim.sample.confidenceTier != null
      ? t('shared.evidence.sampleCue', {
          total: claim.sample.eligibleDenominator,
          tier: t(`shared.evidence.tier.${claim.sample.confidenceTier}`),
        })
      : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('matchups.counterpick.title')}</CardTitle>
        <CardDescription>{t('shared.evidence.type.recommendation')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {claim.kind === 'abstained' ? (
          <p className="text-sm text-muted-foreground">
            {t('shared.evidence.abstained', { count: claim.gamesNeeded })}
          </p>
        ) : (
          <>
            <StageGroup
              title={t('matchups.counterpick.pickThese')}
              tone="emerald"
              stages={picks}
              sampleCueText={sampleCueText}
            />
            {bans.length > 0 && (
              <StageGroup
                title={t('matchups.counterpick.banThese')}
                tone="destructive"
                stages={bans}
                sampleCueText={sampleCueText}
              />
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function StageGroup({
  title,
  tone,
  stages,
  sampleCueText,
}: {
  title: string;
  tone: 'emerald' | 'destructive';
  stages: RankedStage[];
  sampleCueText: string | null;
}) {
  const { t } = useTranslation();
  return (
    <div>
      <h3
        className={`mb-2 text-sm font-medium ${tone === 'emerald' ? 'text-emerald-500' : 'text-destructive'}`}
      >
        {title}
      </h3>
      <ul className="flex flex-col gap-2">
        {stages.map((stage) => {
          const stageData = stagesById.get(stage.stageId);
          return (
            <li key={stage.stageId} className="flex items-center justify-between gap-2">
              {stageData ? (
                <StageOption stage={stageData} />
              ) : (
                <span className="text-sm">{t('matchups.counterpick.unknownStage')}</span>
              )}
              <span className="shrink-0 whitespace-nowrap text-sm text-muted-foreground">
                {stage.wins}-{stage.losses}{' '}
                {t('common.rateOverSample', { rate: stage.winRate, total: stage.total })}
                {sampleCueText ? ` · ${sampleCueText}` : ''}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
