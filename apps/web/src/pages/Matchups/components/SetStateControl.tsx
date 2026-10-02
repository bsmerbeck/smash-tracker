import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { Ruleset, SetState } from '@smash-tracker/shared';
import { SegmentedControl } from '@/components/analytics/SegmentedControl';
import { MUTED_LINK_TONE } from '@/components/analytics/linkTone';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from '@/components/ui/popover';
import { getStageById } from '@/data/stages';
import { cn } from '@/lib/utils';

/**
 * The composed "assuming X · Y · Z" sentence both this control's trigger
 * and `CounterpickAdvisor`'s always-visible under-title line render (D-11)
 * — a single pure function factored out so the two call sites can never say
 * two different things about the same `SetState`.
 */
export function describeSetStateAssumption(t: TFunction, setState: SetState): string {
  const priorCount = setState.priorStages.length;
  const priorSummary =
    priorCount === 0
      ? t('matchups.counterpick.setState.priorNone')
      : t('matchups.counterpick.setState.priorSummary', { count: priorCount });
  const bansCount = setState.bannedStageIds.length;
  const bansSummary =
    bansCount === 0
      ? t('matchups.counterpick.setState.bansNone')
      : t('matchups.counterpick.setState.bansSummary', { count: bansCount });
  return t('matchups.counterpick.setState.summary', {
    phase: t(`matchups.counterpick.setState.phase.${setState.phase}`),
    role: t(`matchups.counterpick.setState.role.${setState.role}`),
    priorSummary: `${priorSummary}, ${bansSummary}`,
  });
}

/**
 * The D-11 set-state EDITOR for the two checklists (plan 37-05; plan 39.1-47
 * moved the game-phase and role choices out into `CounterpickAdvisor`'s two
 * segmented controls, sketch 003 B, so this popover holds only what cannot be
 * a segment). Every clause is entered explicitly by the player — nothing is
 * ever inferred from match data, and nothing here is persisted: the state
 * lives in `CounterpickAdvisor`'s component state for the session only, and
 * is reset whenever the pairing changes. This is deliberate — it introduces
 * no new storage surface, so none of Phase 35's subject-scoped persistence
 * rules are engaged.
 *
 * The two checklists ("prior stages played", "banned so far") are drawn from
 * every stage legal under the ACTIVE RULESET (starters + counterpicks
 * combined) — not `legalStagesFor`'s narrower, setState-dependent result,
 * since that would create a circular dependency: you can't ask "which
 * stages are legal here" using the very inputs this control is collecting.
 */
export function SetStateControl({
  ruleset,
  setState,
  onChange,
  describedById,
}: {
  ruleset: Ruleset;
  setState: SetState;
  onChange: (next: SetState) => void;
  /**
   * Plan 39.1-30 (item 1): the id of the element that STATES the composed
   * assumption sentence (`CounterpickAdvisor`'s always-visible under-title
   * line) — wired to the trigger's `aria-describedby` so the sentence isn't
   * restated a second time as the trigger's own accessible name.
   */
  describedById?: string;
}) {
  const { t } = useTranslation();
  const allRulesetStageIds = [...ruleset.starterStageIds, ...ruleset.counterpickStageIds].sort(
    (a, b) => a - b,
  );

  function togglePriorStage(stageId: number, checked: boolean) {
    if (checked) {
      onChange({ ...setState, priorStages: [...setState.priorStages, { stageId, won: false }] });
    } else {
      onChange({
        ...setState,
        priorStages: setState.priorStages.filter((p) => p.stageId !== stageId),
      });
    }
  }

  function setPriorStageResult(stageId: number, won: boolean) {
    onChange({
      ...setState,
      priorStages: setState.priorStages.map((p) => (p.stageId === stageId ? { ...p, won } : p)),
    });
  }

  function toggleBannedStage(stageId: number, checked: boolean) {
    onChange({
      ...setState,
      bannedStageIds: checked
        ? [...setState.bannedStageIds, stageId]
        : setState.bannedStageIds.filter((id) => id !== stageId),
    });
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="link"
          size="sm"
          aria-describedby={describedById}
          className={cn(MUTED_LINK_TONE, 'h-auto px-1 py-0 text-xs underline')}
        >
          {t('matchups.counterpick.setState.playedBans')}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 text-sm">
        <PopoverHeader>
          <PopoverTitle>{t('matchups.counterpick.setState.editAria')}</PopoverTitle>
        </PopoverHeader>
        <div className="mt-3 flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label>{t('matchups.counterpick.setState.priorStagesLabel')}</Label>
            <div className="flex max-h-40 flex-col gap-2 overflow-y-auto">
              {allRulesetStageIds.map((stageId) => {
                const prior = setState.priorStages.find((p) => p.stageId === stageId);
                const stageName = getStageById(stageId)?.name ?? stageId;
                return (
                  <div key={stageId} className="flex flex-col gap-1">
                    <div className="flex items-center gap-2">
                      <Checkbox
                        id={`set-state-prior-${stageId}`}
                        checked={prior != null}
                        onCheckedChange={(checked) => togglePriorStage(stageId, checked === true)}
                      />
                      <Label htmlFor={`set-state-prior-${stageId}`} className="min-w-0 truncate">
                        {stageName}
                      </Label>
                    </div>
                    {prior != null && (
                      <SegmentedControl
                        label={t('matchups.counterpick.setState.priorResultLabel', {
                          stage: stageName,
                        })}
                        value={prior.won ? 'won' : 'lost'}
                        onChange={(value) => setPriorStageResult(stageId, value === 'won')}
                        options={[
                          { value: 'won', label: t('matchups.counterpick.setState.wonLabel') },
                          { value: 'lost', label: t('matchups.counterpick.setState.lostLabel') },
                        ]}
                        className="ml-6 w-fit"
                      />
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <Label>{t('matchups.counterpick.setState.bansLabel')}</Label>
            <div className="flex max-h-40 flex-col gap-2 overflow-y-auto">
              {allRulesetStageIds.map((stageId) => {
                const stageName = getStageById(stageId)?.name ?? stageId;
                return (
                  <div key={stageId} className="flex items-center gap-2">
                    <Checkbox
                      id={`set-state-ban-${stageId}`}
                      checked={setState.bannedStageIds.includes(stageId)}
                      onCheckedChange={(checked) => toggleBannedStage(stageId, checked === true)}
                    />
                    <Label htmlFor={`set-state-ban-${stageId}`} className="min-w-0 truncate">
                      {stageName}
                    </Label>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
