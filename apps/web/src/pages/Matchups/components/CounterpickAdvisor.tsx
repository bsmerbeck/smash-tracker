import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { resolveRuleset, legalStagesFor, DEFAULT_SET_STATE } from '@smash-tracker/shared';
import type { Match, SetState } from '@smash-tracker/shared';
import { ChartCard } from '@/components/charts/ChartCard';
import { ComparisonBars, type ComparisonBarsRow } from '@/components/charts/ComparisonBars';
import { SampleCue } from '@/components/EvidenceCues';
import { RulesetDisclosure } from '@/components/RulesetDisclosure';
import { StageOption } from '@/components/StageOption';
import { buildStageEvidence, pickBanSplit, type RankedStage } from '@/lib/stats';
import { stagesById } from '@/data/stages';
import { useMinStageMatches } from '@/hooks/useMinStageMatches';
import { advisorThreshold } from '../lib/advisorThreshold';
import { MATCHUP_TABLE_ANCHOR_ID } from '../lib/matchupAnchors';
import { useMatchupsContext } from '../MatchupsContext';
import { SetStateControl, describeSetStateAssumption } from './SetStateControl';

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
 *
 * D-11: the set state (game phase, role, prior stages, bans) is component
 * state for the session only — entered through `SetStateControl`, never
 * inferred from match data, and never persisted. It resets to
 * `DEFAULT_SET_STATE` whenever the pairing changes (derived from the first
 * match's fighter/opponent ids, since this component only ever receives an
 * already-pairing-filtered array) so an assumption entered for one pairing
 * can never silently carry into the next.
 *
 * D-12/EVID-05: the ruleset control and the set-state assumption are BOTH
 * always visible — the ruleset/set-state controls sit in the frame's header
 * slot beside the sample cue, and the composed assumption sentence renders
 * once, as plain muted text directly under the title (never inside a
 * tooltip or a hover-only surface). When the active ruleset+set-state
 * combination leaves NO stage legal, the card says exactly that
 * (`noLegalStages`) instead of the generic abstention sentence, which would
 * misdescribe a full sample as a thin one.
 *
 * D-07/Phase 38-04: clicking a Pick or Ban row writes the stage axis to the
 * URL (via the Matchups context's `setDrillDown`) and scrolls to the
 * results table — the exact "write drill-down state, then scroll to an
 * exported anchor id" idiom `MatchupChart`'s point click and
 * `MatchupMatrix`'s cell click already use, so this page has one drill-down
 * mechanism, not two. Phase 38 is now the owner of that URL contract — this
 * head comment previously said no URL or search param was touched here;
 * that is no longer true, by design.
 */
export function CounterpickAdvisor({ matchupMatches }: { matchupMatches: Match[] }) {
  const { t } = useTranslation();
  const [minGames] = useMinStageMatches();
  const { setDrillDown } = useMatchupsContext();
  // React Compiler forbids a bare `Date.now()` call in the render body (it's
  // impure) — a lazy `useState` initializer is the sanctioned one-time-read
  // escape hatch; a stale `refreshedAt` across re-renders is harmless since
  // it's provenance metadata on the claim, not part of the ranking math.
  const [refreshedAt] = useState(() => Date.now());

  const resolvedRuleset = resolveRuleset(undefined);

  const pairingKey =
    matchupMatches.length > 0
      ? `${matchupMatches[0]!.fighter_id}:${matchupMatches[0]!.opponent_id}`
      : 'none';
  const [setState, setSetState] = useState<SetState>(DEFAULT_SET_STATE);
  // Render-time state adjustment (mirrors `RulesetOverrideSection`'s
  // `wasDialogOpen` pattern): resets the set state the moment the pairing
  // key changes, rather than in an effect — no render is ever committed
  // with a stale pairing's assumption on screen.
  const [lastPairingKey, setLastPairingKey] = useState(pairingKey);
  if (pairingKey !== lastPairingKey) {
    setLastPairingKey(pairingKey);
    setSetState(DEFAULT_SET_STATE);
  }

  const legalStageIds = new Set(legalStagesFor(resolvedRuleset.ruleset, setState));
  const noLegalStages = legalStageIds.size === 0;

  const threshold = advisorThreshold(minGames);
  const { claim } = buildStageEvidence({
    matches: matchupMatches,
    refreshedAt,
    minMatches: threshold,
    legalStageIds,
  });
  const ranked = claim.kind === 'evidenced' ? claim.value : [];
  const { picks, bans } = pickBanSplit(ranked);

  // Numeric stage id comparison only (never a localized stage name) —
  // `row.key` is `String(stage.stageId)` (set in `toRow` below).
  function handleSelectRow(row: ComparisonBarsRow) {
    const stageId = Number(row.key);
    setDrillDown({ stageId });
    document
      .getElementById(MATCHUP_TABLE_ANCHOR_ID)
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

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
      headerRight={
        <div className="flex flex-wrap items-center justify-end gap-2">
          <SampleCue sample={claim.sample} />
          <RulesetDisclosure resolved={resolvedRuleset} />
          <SetStateControl
            ruleset={resolvedRuleset.ruleset}
            setState={setState}
            onChange={setSetState}
          />
        </div>
      }
      abstained={
        !noLegalStages && claim.kind === 'abstained' ? { gamesNeeded: claim.gamesNeeded } : null
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground" data-testid="set-state-assumption-line">
          {describeSetStateAssumption(t, setState)}
        </p>
        {noLegalStages ? (
          <p className="text-sm text-muted-foreground">{t('matchups.counterpick.noLegalStages')}</p>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              {t('matchups.counterpick.threshold', { count: threshold })}
            </p>
            <div>
              <h3 className="mb-2 text-sm font-medium text-emerald-500">
                {t('matchups.counterpick.pickThese')}
              </h3>
              <ComparisonBars
                tone="emerald"
                rows={picks.map(toRow)}
                onSelectRow={handleSelectRow}
              />
            </div>
            {bans.length > 0 && (
              <div>
                <h3 className="mb-2 text-sm font-medium text-destructive">
                  {t('matchups.counterpick.banThese')}
                </h3>
                <ComparisonBars
                  tone="destructive"
                  rows={bans.map(toRow)}
                  onSelectRow={handleSelectRow}
                />
              </div>
            )}
          </>
        )}
      </div>
    </ChartCard>
  );
}
