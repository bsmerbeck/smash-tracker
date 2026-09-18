import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { resolveRuleset, legalStagesFor, DEFAULT_SET_STATE } from '@smash-tracker/shared';
import type { Match } from '@smash-tracker/shared';
import { ChartCard } from '@/components/charts/ChartCard';
import { ComparisonBars, type ComparisonBarsRow } from '@/components/charts/ComparisonBars';
import { SampleCue } from '@/components/EvidenceCues';
import { StageOption } from '@/components/StageOption';
import { buildStageEvidence, pickBanSplit, type RankedStage } from '@/lib/stats';
import { stagesById } from '@/data/stages';
import { useMinStageMatches } from '@/hooks/useMinStageMatches';
import { advisorThreshold } from '../lib/advisorThreshold';

/**
 * Stage counterpick advisor for the selected pairing (D-05, D-07, D-11,
 * D-13, ADV-01, EVID-04, EVID-05 — plan 37-05). Gates, ranks and splits
 * through the shared evidence engine's own functions rather than any local
 * re-derivation:
 *
 * - The legal-stage filter (`legalStagesFor`) narrows the candidate set
 *   BEFORE `buildStageEvidence`'s internal `gateBySampleSize` runs, so a
 *   stage excluded by the active ruleset can never be miscounted as
 *   evidenced or leak into a Pick/Ban bucket.
 * - `pickBanSplit` (the engine's ONE pick/ban function, D-15) replaces the
 *   local slice this component used to own — no local `PICK_BAN_COUNT`
 *   survives here.
 * - `advisorThreshold` is the ONE binding both the rendered threshold line
 *   and the `buildStageEvidence` call read (D-13) — never two independent
 *   expressions that merely happen to agree. See
 *   `apps/web/src/pages/Matchups/lib/advisorThreshold.ts`'s doc comment for
 *   why the seam is a separate module.
 *
 * Matchups is not event-scoped this phase (D-18 keeps tournaments
 * own-account only, and Phase 37 doesn't wire a per-tournament ruleset onto
 * a fighter-pairing surface) — `resolveRuleset(undefined)` always resolves
 * to the house default here. This is deliberate, not an oversight: the
 * override badge path exists and is unit-tested in `RulesetDisclosure`, but
 * never fires on this surface.
 */
export function CounterpickAdvisor({ matchupMatches }: { matchupMatches: Match[] }) {
  const { t } = useTranslation();
  const [minGames] = useMinStageMatches();
  // React Compiler forbids a bare `Date.now()` call in the render body (it's
  // impure) — a lazy `useState` initializer is the sanctioned one-time-read
  // escape hatch; a stale `refreshedAt` across re-renders is harmless since
  // it's provenance metadata on the claim, not part of the ranking math.
  const [refreshedAt] = useState(() => Date.now());

  const resolvedRuleset = resolveRuleset(undefined);
  // The set state controls arrive in this plan's Task 2 (D-11); this task
  // renders the fixed default only.
  const setState = DEFAULT_SET_STATE;
  const legalStageIds = new Set(legalStagesFor(resolvedRuleset.ruleset, setState));

  const threshold = advisorThreshold(minGames);
  const { claim } = buildStageEvidence({
    matches: matchupMatches,
    refreshedAt,
    minMatches: threshold,
    legalStageIds,
  });
  const ranked = claim.kind === 'evidenced' ? claim.value : [];
  const { picks, bans } = pickBanSplit(ranked);

  function toRow(stage: RankedStage): ComparisonBarsRow {
    const stageData = stagesById.get(stage.stageId);
    return {
      key: String(stage.stageId),
      label: stageData ? (
        <StageOption stage={stageData} />
      ) : (
        <span className="text-sm">{t('matchups.counterpick.unknownStage')}</span>
      ),
      value: stage.winRate,
      valueLabel: `${stage.wins}-${stage.losses} ${t('common.rateOverSample', {
        rate: stage.winRate,
        total: stage.total,
      })}`,
    };
  }

  return (
    <ChartCard
      title={t('matchups.counterpick.title')}
      caption={t('shared.evidence.type.recommendation')}
      headerRight={<SampleCue sample={claim.sample} />}
      abstained={claim.kind === 'abstained' ? { gamesNeeded: claim.gamesNeeded } : null}
    >
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">
          {t('matchups.counterpick.threshold', { count: threshold })}
        </p>
        <div>
          <h3 className="mb-2 text-sm font-medium text-emerald-500">
            {t('matchups.counterpick.pickThese')}
          </h3>
          <ComparisonBars tone="emerald" rows={picks.map(toRow)} />
        </div>
        {bans.length > 0 && (
          <div>
            <h3 className="mb-2 text-sm font-medium text-destructive">
              {t('matchups.counterpick.banThese')}
            </h3>
            <ComparisonBars tone="destructive" rows={bans.map(toRow)} />
          </div>
        )}
      </div>
    </ChartCard>
  );
}
