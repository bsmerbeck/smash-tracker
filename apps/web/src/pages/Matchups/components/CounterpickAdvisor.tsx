import { useId, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { resolveRuleset, legalStagesFor, DEFAULT_SET_STATE } from '@smash-tracker/shared';
import type { Match, SetState } from '@smash-tracker/shared';
import { ClaimChip } from '@/components/analytics/ClaimChip';
import { SegmentedControl } from '@/components/analytics/SegmentedControl';
import { ComparisonBars, type ComparisonBarsRow } from '@/components/charts/ComparisonBars';
import { CHART_TOKENS } from '@/components/charts/tokens';
import { RulesetDisclosure } from '@/components/RulesetDisclosure';
import { Card } from '@/components/ui/card';
import { buildStageEvidence, pickBanSplit, type RankedStage } from '@/lib/stats';
import { useMinStageMatches } from '@/hooks/useMinStageMatches';
import { advisorThreshold } from '../lib/advisorThreshold';
import { MATCHUP_TABLE_ANCHOR_ID } from '../lib/matchupAnchors';
import { buildStageSeriesRow, pairingWinRate } from '../lib/stageSeries';
import { useMatchupsContext } from '../MatchupsContext';
import { ReferenceSwatch } from './StageSeries';
import { SetStateControl, describeSetStateAssumption } from './SetStateControl';

/** The overline role (StatFigure's label): the Pick / Ban heads read as the Insights card's heads do. */
const OVERLINE_CLASS =
  'text-[0.6875rem] leading-4 font-semibold tracking-wider text-muted-foreground uppercase';

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
 * always visible, in the abstained and the populated branch alike. Plan
 * 39.1-47 (sketch 003 B, PD-47-1..3) rebuilt the card as an insight card: one
 * top line (suggestion chip + "Counterpick Advisor · all time · min N games
 * per stage" — the threshold and the evidence type folded into it, no toolbar
 * SampleCue chip), ONE assumption line (the ruleset disclosure plus the
 * composed "Assuming …" sentence, plain muted text, never inside a tooltip),
 * the `set-state-segments` row (Phase and Role as two `SegmentedControl`s
 * plus the "stages played · bans" popover link), then the body. The Role
 * segments are unavailable at Game 1 (there is no pick / ban role before a
 * game has been played); at Game 2+ "Banning (you won)" is role `striking`
 * and "Picking (you lost)" is role `picking`, the only role the DSR clause of
 * `legalStagesFor` narrows. When the active ruleset+set-state combination
 * leaves NO stage legal, the card says exactly that (`noLegalStages`)
 * instead of the generic abstention sentence, which would misdescribe a full
 * sample as a thin one. Pick / Ban are neutral overlines over blue series
 * rows against the pairing's all-time rate — never a status colour: the
 * ranking is the engine's own `pickBanSplit` (PD-47-2), and a hue would read
 * as a verdict the evidence does not carry.
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
  // Stable across re-renders (`useId`, never `Date.now()`/`Math.random()`) —
  // wires the set-state trigger's `aria-describedby` to the sentence that
  // describes it, so the trigger's own accessible name can stay a short
  // constant label without losing the association (plan 39.1-30 item 1).
  const assumptionLineId = useId();
  const topLineId = useId();

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
  // `row.key` is `String(stage.stageId)` (set by `buildStageSeriesRow`).
  function handleSelectRow(row: ComparisonBarsRow) {
    const stageId = Number(row.key);
    setDrillDown({ stageId });
    document
      .getElementById(MATCHUP_TABLE_ANCHOR_ID)
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function toRow(stage: RankedStage): ComparisonBarsRow | null {
    // Text-only like the sketch and the Stage breakdown (PD-46-3): a thumbnail
    // made each row 56 px against the sketch's 38 px and truncated the name.
    return buildStageSeriesRow({ record: stage });
  }

  function toRows(stages: RankedStage[]): ComparisonBarsRow[] {
    return stages.map(toRow).filter((row): row is ComparisonBarsRow => row !== null);
  }

  // Game 1 has no pick / ban role yet: both role options are unavailable and
  // "Striking" is what stands. From Game 2+ the roles read as who won.
  const isGame1 = setState.phase === 'game1';
  const roleValue = isGame1 ? 'striking' : setState.role;
  const roleOptions = isGame1
    ? [
        {
          value: 'striking',
          label: t('matchups.counterpick.setState.role.striking'),
          unavailable: true,
          unavailableReason: t('matchups.counterpick.setState.roleUnavailable'),
          className: 'opacity-60',
        },
        {
          value: 'picking',
          label: t('matchups.counterpick.setState.roleGame2.picking'),
          unavailable: true,
          unavailableReason: t('matchups.counterpick.setState.roleUnavailable'),
          className: 'opacity-60',
        },
      ]
    : [
        { value: 'striking', label: t('matchups.counterpick.setState.roleGame2.banning') },
        { value: 'picking', label: t('matchups.counterpick.setState.roleGame2.picking') },
      ];

  function handlePhaseChange(next: string) {
    const phase = next as SetState['phase'];
    // Choosing Game 1 resets the role: before Game 2 nobody has won or lost yet.
    setSetState({ ...setState, phase, role: phase === 'game1' ? 'striking' : setState.role });
  }

  function handleRoleChange(next: string) {
    setSetState({ ...setState, role: next as SetState['role'] });
  }

  const abstained = !noLegalStages && claim.kind === 'abstained';
  const referenceRate = pairingWinRate(matchupMatches);
  const pickRows = toRows(picks);
  const banRows = toRows(bans);
  // F21 (plan 37-10): the Wilson lower bound can rank a losing record above a
  // thin winning one — intended, but "Pick these" must say so in text.
  // Exactly 50% is not losing.
  const belowEvenCount = picks.filter((s) => s.total > 0 && s.wins / s.total < 0.5).length;

  let body: ReactNode;
  if (noLegalStages) {
    body = (
      <p className="text-sm text-muted-foreground">{t('matchups.counterpick.noLegalStages')}</p>
    );
  } else if (abstained) {
    // The kit's one locked idiom (the period trend's locked inset): the shared
    // sentence, then a 6px meter and its count label sharing one wrapping row.
    const gamesNeeded = claim.kind === 'abstained' ? claim.gamesNeeded : 0;
    const have = Math.max(0, threshold - gamesNeeded);
    const countLabel = t('analytics.timeline.lockedCount', { have, need: threshold });
    body = (
      <div
        data-slot="counterpick-locked"
        className="flex flex-col gap-1.5 rounded-md bg-muted/40 p-3"
      >
        <p className="text-sm leading-5">
          {t('shared.evidence.abstained', { count: gamesNeeded })}
        </p>
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
          <div
            role="img"
            aria-label={countLabel}
            className="h-1.5 min-w-[60px] flex-[1_1_80px] overflow-hidden rounded-full bg-muted"
          >
            <div
              className="h-full rounded-full"
              style={{
                width: `${Math.min(100, Math.round((have / threshold) * 100))}%`,
                backgroundColor: CHART_TOKENS.steady,
              }}
            />
          </div>
          <span className="text-xs leading-4 whitespace-nowrap text-muted-foreground tabular-nums">
            {countLabel}
          </span>
        </div>
      </div>
    );
  } else {
    body = (
      <>
        <div data-slot="counterpick-pick" className="flex min-w-0 flex-col gap-1">
          <h2 className={OVERLINE_CLASS}>{t('matchups.counterpick.pickThese')}</h2>
          <ComparisonBars
            tone="series"
            rows={pickRows}
            referenceRate={referenceRate}
            onSelectRow={handleSelectRow}
          />
          {belowEvenCount > 0 && (
            <p
              data-slot="counterpick-pick-below-even"
              className="text-xs leading-4 text-muted-foreground"
            >
              {t('matchups.counterpick.picksBelowEven', { count: belowEvenCount })}
            </p>
          )}
        </div>
        {banRows.length > 0 && (
          <div data-slot="counterpick-ban" className="flex min-w-0 flex-col gap-1">
            <h2 className={OVERLINE_CLASS}>{t('matchups.counterpick.banThese')}</h2>
            <ComparisonBars
              tone="series"
              rows={banRows}
              referenceRate={referenceRate}
              onSelectRow={handleSelectRow}
            />
          </div>
        )}
        <p
          data-slot="counterpick-legend"
          className="flex flex-wrap items-center gap-x-1.5 text-xs leading-4 text-muted-foreground"
        >
          <ReferenceSwatch />
          <span>
            {t('analytics.trend.legend.reference', { rate: `${Math.round(referenceRate)}%` })}
          </span>
        </p>
      </>
    );
  }

  return (
    <Card role="region" aria-labelledby={topLineId} className="gap-3 p-5 shadow-none">
      <div className="flex flex-wrap items-center gap-2">
        <ClaimChip
          kind="suggestion"
          locked={abstained}
          label={
            abstained ? t('matchups.counterpick.suggestionLocked') : t('insights.kind.suggestion')
          }
        />
        <span id={topLineId} className="text-xs leading-4 text-muted-foreground tabular-nums">
          {t('matchups.counterpick.meta', { count: threshold })}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <RulesetDisclosure resolved={resolvedRuleset} />
        <p
          id={assumptionLineId}
          className="min-w-0 text-sm text-muted-foreground"
          data-testid="set-state-assumption-line"
        >
          {describeSetStateAssumption(t, setState)}
        </p>
      </div>

      <div data-slot="set-state-segments" className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <SegmentedControl
          label={t('matchups.counterpick.setState.phaseLabel')}
          value={setState.phase}
          onChange={handlePhaseChange}
          options={[
            { value: 'game1', label: t('matchups.counterpick.setState.phase.game1') },
            { value: 'game2plus', label: t('matchups.counterpick.setState.phase.game2plus') },
          ]}
        />
        <SegmentedControl
          label={t('matchups.counterpick.setState.roleLabel')}
          value={roleValue}
          onChange={handleRoleChange}
          options={roleOptions}
        />
        <SetStateControl
          ruleset={resolvedRuleset.ruleset}
          setState={setState}
          onChange={setSetState}
          describedById={assumptionLineId}
        />
      </div>

      {body}
    </Card>
  );
}
