import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { CreateMatchInput } from '@smash-tracker/shared';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { NO_SELECTION_STAGE } from '@/data/stages';
import { useCreateMatch } from '@/hooks/useCreateMatch';
import {
  MatchFormFields,
  alphaSpriteList,
  matchFormValuesToInput,
  useMatchForm,
  type MatchFormValues,
} from '@/components/match-form/MatchForm';
import {
  SetWizard,
  useSetSharedForm,
  defaultSetSharedValues,
} from '@/components/match-form/SetWizard';
import {
  formatSetScore,
  getSetScore,
  type SetGameValues,
} from '@/components/match-form/setWizardLogic';
import { useDashboardContext } from '../DashboardContext';

type EntryMode = 'single' | 'set';

function buildDefaultValues(fighterId: number): MatchFormValues {
  return {
    fighterId,
    opponentFighterId: alphaSpriteList[0]?.id ?? 0,
    result: undefined as unknown as MatchFormValues['result'],
    stageId: NO_SELECTION_STAGE.id,
    matchType: 'none',
    // 'unknown' by default: most quickplay opponents are randoms, and forcing
    // a typed name for every match was the top friction in the add flow. All
    // untouched entries aggregate under one "unknown" opponent (names are
    // the RTDB key), and the combobox still lets you replace it.
    opponentName: 'unknown',
    notes: '',
    stocksLeft: undefined,
    eventName: '',
    tournamentName: '',
    gsp: '',
  };
}

/**
 * Ports legacy/src/screens/Dashboard/components/DashboardToolbar/components/AddMatchForm.
 * Opens from a trigger button in the dashboard toolbar; submits via
 * useCreateMatch (which invalidates matches + opponents so a newly typed
 * opponent name shows up next time). Field UI lives in the shared
 * `MatchForm` component so EditMatchForm (MatchData screen) doesn't
 * duplicate it.
 *
 * V4 Phase F adds a mode toggle: "Single game" is the original form
 * (+ stocks/tournament fields); "Set (Bo3/Bo5)" opens the `SetWizard`,
 * which collects shared fields once and per-game rows progressively, then
 * submits one match per game sequentially via the same create-match
 * mutation (no cross-game transaction/rollback — see `handleSetSubmit`).
 */
export function AddMatchForm() {
  const { t } = useTranslation();
  const { fighter, fighterSprites } = useDashboardContext();
  const createMatch = useCreateMatch();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<EntryMode>('single');
  const [games, setGames] = useState<SetGameValues[]>([]);

  const form = useMatchForm(buildDefaultValues(fighter?.id ?? fighterSprites[0]?.id ?? 0));
  const setForm = useSetSharedForm(
    defaultSetSharedValues(fighter?.id ?? fighterSprites[0]?.id ?? 0),
  );

  function resetAll() {
    const fighterId = fighter?.id ?? fighterSprites[0]?.id ?? 0;
    form.reset(buildDefaultValues(fighterId));
    setForm.reset(defaultSetSharedValues(fighterId));
    setGames([]);
    setMode('single');
  }

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (next) {
      resetAll();
    }
  }

  async function onSubmit(values: MatchFormValues) {
    const input: CreateMatchInput = matchFormValuesToInput(values);
    try {
      await createMatch.mutateAsync(input);
      toast.success(t('dashboard.addMatch.added'));
      setOpen(false);
    } catch {
      toast.error(t('dashboard.addMatch.addFailed'));
    }
  }

  /**
   * Creates one match per game, sequentially, via the same `useCreateMatch`
   * mutation the single-game form uses. There is no rollback if a later
   * game fails — earlier games in the set are already persisted, so a
   * partial failure is reported honestly (how many games saved vs. how
   * many were requested) rather than silently discarded.
   */
  async function handleSetSubmit(payloads: CreateMatchInput[]) {
    if (payloads.length === 0) {
      toast.error(t('dashboard.addMatch.noGames'));
      return;
    }

    let savedCount = 0;
    try {
      for (const payload of payloads) {
        await createMatch.mutateAsync(payload);
        savedCount += 1;
      }
      const score = getSetScore(
        payloads.map((p) => ({ result: p.win ? 'win' : 'loss', stageId: 0 })),
      );
      const opponentName = payloads[0]?.opponent ?? 'opponent';
      toast.success(
        t('dashboard.addMatch.setRecorded', {
          score: formatSetScore(score),
          opponent: opponentName,
        }),
      );
      setOpen(false);
    } catch {
      if (savedCount > 0) {
        toast.error(
          t('dashboard.addMatch.partialSave', { saved: savedCount, total: payloads.length }),
        );
      } else {
        toast.error(t('dashboard.addMatch.setFailed'));
      }
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button disabled={fighterSprites.length === 0}>{t('dashboard.addMatch.title')}</Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('dashboard.addMatch.title')}</DialogTitle>
          <DialogDescription>{t('dashboard.addMatch.description')}</DialogDescription>
        </DialogHeader>

        <ToggleGroup
          type="single"
          variant="outline"
          value={mode}
          onValueChange={(value) => {
            if (value) setMode(value as EntryMode);
          }}
          className="mb-2"
        >
          <ToggleGroupItem value="single" aria-label={t('dashboard.addMatch.singleGame')}>
            {t('dashboard.addMatch.singleGame')}
          </ToggleGroupItem>
          <ToggleGroupItem value="set" aria-label={t('dashboard.addMatch.setMode')}>
            {t('dashboard.addMatch.setMode')}
          </ToggleGroupItem>
        </ToggleGroup>

        {mode === 'single' ? (
          <form onSubmit={form.handleSubmit(onSubmit)} noValidate>
            <MatchFormFields form={form} fighterSprites={fighterSprites} />
            <DialogFooter className="mt-4">
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                {t('common.cancel')}
              </Button>
              <Button type="submit" disabled={createMatch.isPending}>
                {t('common.save')}
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <SetWizard
            fighterSprites={fighterSprites}
            form={setForm}
            games={games}
            onGamesChange={setGames}
            onSubmit={handleSetSubmit}
            footer={
              <DialogFooter className="mt-4">
                <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                  {t('common.cancel')}
                </Button>
                <Button type="submit" disabled={createMatch.isPending}>
                  {t('dashboard.addMatch.saveSet')}
                </Button>
              </DialogFooter>
            }
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
