import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { Match } from '@smash-tracker/shared';
import {
  buildStageEvidence,
  getBestWorstStages,
  getMatchTypeRecords,
  getStreakSummary,
} from '@/lib/stats';
import { stagesById } from '@/data/stages';
import { WinLossPips } from '@/components/WinLossPips';
import { MIN_STAGE_MATCHES_OPTIONS } from '@/lib/analyticsSelection';
import { useMinStageMatches } from '@/hooks/useMinStageMatches';
import { SampleCue, UnknownRow, MixedContextBadge } from '@/components/EvidenceCues';

/**
 * Plan 39.1-13 (UI-SPEC §9.6): `getMatchTypeRecords`' raw `matchType` literal
 * (`'quickplay'`, `'online-tourney'`, …, `'unspecified'`) -> `analytics.matchType.*`.
 * `'unspecified'` (the empty/`'none'`-value bucket `getMatchTypeRecords`
 * groups under) has no key of its own — `analytics.matchType.none`
 * ("Unspecified") is the same bucket under a different name, so it is the
 * fallback target rather than a ninth locale key.
 */
function matchTypeLabel(matchType: string, t: TFunction): string {
  const key = matchType === 'unspecified' ? 'none' : matchType;
  return t(`analytics.matchType.${key}`, { defaultValue: matchType });
}

/**
 * v2 analytics for the selected matchup: current/best/worst streaks, recent
 * form, the best and worst stage to take this matchup to (threshold-based),
 * and the record split by match type. Phase 35-03 (D-11): the threshold is
 * the one shared per-subject value `useMinStageMatches` owns — changing it
 * here moves Counterpick Advisor and Matchup Stage Guide too.
 *
 * Phase 36 (EVID-06, EVID-10): the best/worst-stage empty branch now reads
 * the shared abstained sentence (with the exact remaining-games count) off
 * `buildStageEvidence` rather than a bespoke "not enough stage data" string,
 * every stage line carries the shared sample/confidence cue, an evidence-type
 * caption marks this card as an inference (not a guaranteed recommendation),
 * an unknown-stage row is disclosed when present, and a mixed-context badge
 * flags a session-type/provenance split — the same claim shape every other
 * advisor surface renders from (D-13, no new visual language).
 */
export function MatchupInsights({ matchupMatches }: { matchupMatches: Match[] }) {
  const { t } = useTranslation();
  const [threshold, setThreshold] = useMinStageMatches();
  // React Compiler forbids a bare `Date.now()` call in the render body (it's
  // impure) — a lazy `useState` initializer is the sanctioned one-time-read
  // escape hatch, matching `CounterpickAdvisor.tsx`'s convention.
  const [refreshedAt] = useState(() => Date.now());

  const streaks = getStreakSummary(matchupMatches);
  const { best, worst } = getBestWorstStages(matchupMatches, threshold);
  const typeRecords = getMatchTypeRecords(matchupMatches);
  const { claim, unknown, cohort } = buildStageEvidence({
    matches: matchupMatches,
    refreshedAt,
    minMatches: threshold,
  });
  const sampleCue = claim.kind === 'evidenced' ? <SampleCue sample={claim.sample} /> : null;
  const abstainedGamesNeeded = claim.kind === 'abstained' ? claim.gamesNeeded : 0;

  const bestName = best ? (stagesById.get(best.stageId)?.name ?? t('common.unknown')) : null;
  const worstName = worst ? (stagesById.get(worst.stageId)?.name ?? t('common.unknown')) : null;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <CardTitle>{t('matchups.insights.title')}</CardTitle>
            <MixedContextBadge cohort={cohort} />
          </div>
          <CardDescription>{t('shared.evidence.type.inference')}</CardDescription>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">{t('matchups.insights.minMatches')}</span>
          <Select value={String(threshold)} onValueChange={(v) => setThreshold(Number(v))}>
            <SelectTrigger className="w-[72px]" aria-label={t('matchups.insights.minMatchesAria')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MIN_STAGE_MATCHES_OPTIONS.map((option) => (
                <SelectItem key={option} value={String(option)}>
                  {option}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {matchupMatches.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('matchups.insights.empty')}</p>
        ) : (
          <>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div>
                <h3 className="text-sm font-medium text-muted-foreground">
                  {t('matchups.insights.currentStreak')}
                </h3>
                <p
                  className={`text-lg font-semibold ${streaks.currentStreakIsWin ? 'text-emerald-500' : 'text-destructive'}`}
                >
                  {streaks.currentStreakIsWin
                    ? t('matchups.insights.streakWins', { count: streaks.currentStreak })
                    : t('matchups.insights.streakLosses', { count: streaks.currentStreak })}
                </p>
              </div>
              <div>
                <h3 className="text-sm font-medium text-muted-foreground">
                  {t('matchups.insights.longestWin')}
                </h3>
                <p className="text-lg font-semibold">{streaks.bestWinStreak}</p>
              </div>
              <div>
                <h3 className="text-sm font-medium text-muted-foreground">
                  {t('matchups.insights.longestLoss')}
                </h3>
                <p className="text-lg font-semibold">{streaks.worstLossStreak}</p>
              </div>
            </div>

            <div>
              <h3 className="mb-2 text-sm font-medium text-muted-foreground">
                {t('matchups.insights.recentForm')}
              </h3>
              <WinLossPips matches={matchupMatches} limit={10} />
            </div>

            <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <li>
                <h3 className="text-sm font-medium text-emerald-500">
                  {t('matchups.insights.bestStage')}
                </h3>
                <p className="text-sm">
                  {bestName ? (
                    <>
                      {bestName}{' '}
                      <span className="text-muted-foreground">
                        {t('common.rateOverSample', { rate: best?.winRate, total: best?.total })}
                      </span>{' '}
                      {sampleCue}
                    </>
                  ) : (
                    <span className="text-muted-foreground">
                      {t('shared.evidence.abstained', { count: abstainedGamesNeeded })}
                    </span>
                  )}
                </p>
              </li>
              <li>
                <h3 className="text-sm font-medium text-destructive">
                  {t('matchups.insights.worstStage')}
                </h3>
                <p className="text-sm">
                  {worstName ? (
                    <>
                      {worstName}{' '}
                      <span className="text-muted-foreground">
                        {t('common.rateOverSample', { rate: worst?.winRate, total: worst?.total })}
                      </span>{' '}
                      {sampleCue}
                    </>
                  ) : claim.kind === 'evidenced' ? (
                    // WR-02: the query is NOT abstained here (claim.kind is
                    // 'evidenced' — best/worst-stage claim, not the raw
                    // sample-size gate) — `worst` is null only because
                    // exactly one stage qualifies (`getBestWorstStages`: "a
                    // single stage can't be both the recommendation and the
                    // warning"). Reusing the generic abstained sentence here
                    // would fabricate a `gamesNeeded: 0` and claim "0 more
                    // games needed", which is both untrue and impossible to
                    // act on. This dedicated copy names what would actually
                    // change the state: playing on a second stage.
                    <span className="text-muted-foreground">
                      {t('matchups.insights.singleStageOnly')}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">
                      {t('shared.evidence.abstained', { count: abstainedGamesNeeded })}
                    </span>
                  )}
                </p>
              </li>
              <UnknownRow bucket={unknown} as="li" />
            </ul>

            {typeRecords.length > 0 && (
              <div>
                <h3 className="mb-2 text-sm font-medium text-muted-foreground">
                  {t('matchups.insights.byMatchType')}
                </h3>
                <ul className="flex flex-col gap-1 text-sm">
                  {typeRecords.map((record) => (
                    <li key={record.matchType} className="flex justify-between">
                      <span>{matchTypeLabel(record.matchType, t)}</span>
                      <span className="text-muted-foreground">
                        {record.wins}-{record.losses} ({record.winRate}%)
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
