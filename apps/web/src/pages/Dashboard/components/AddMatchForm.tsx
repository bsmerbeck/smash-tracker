import { useContext, useState, type ComponentProps } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { CreateMatchInput, Fighter, Match } from '@smash-tracker/shared';
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
import { PendingButton } from '@/components/ui/pending-button';
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
import { DashboardContext } from '../DashboardContext';

type EntryMode = 'single' | 'set';

function buildDefaultValues(fighterId: number): MatchFormValues {
  return {
    fighterId,
    opponentFighterId: alphaSpriteList[0]?.id ?? 0,
    result: undefined as unknown as MatchFormValues['result'],
    stageId: NO_SELECTION_STAGE.id,
    stageForm: undefined,
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
    vodUrl: '',
    vodStartSeconds: '',
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
 *
 * VOD Manager's toolbar mounts this same dialog with `requireVod` +
 * trigger-customization props (see VodManagerPage) so a match added from
 * the VOD page always carries a link. When called with no props (Dashboard),
 * `fighterSprites`/`fighter` fall back to `DashboardContext` and the trigger
 * renders exactly as before — a non-throwing `useContext` read keeps this
 * component usable outside the Dashboard's provider tree.
 */
export function AddMatchForm({
  requireVod = false,
  triggerLabel,
  triggerVariant,
  triggerSize,
  fighterSprites: fighterSpritesProp,
  fighter: fighterProp,
  onCreated,
}: {
  requireVod?: boolean;
  triggerLabel?: string;
  triggerVariant?: ComponentProps<typeof Button>['variant'];
  triggerSize?: ComponentProps<typeof Button>['size'];
  fighterSprites?: Fighter[];
  fighter?: Fighter;
  /**
   * SESSM-02: optional hook fired with the resolved `Match` (incl. `id`)
   * each time a game is successfully persisted — once in single-game mode,
   * once per game (in order) in set mode. Purely additive: omitting it
   * (all 3 pre-existing mount points) changes nothing about submit/toast/
   * dialog-close behavior.
   */
  onCreated?: (match: Match) => void;
} = {}) {
  const { t } = useTranslation();
  const dashboardContext = useContext(DashboardContext);
  const fighterSprites = fighterSpritesProp ?? dashboardContext?.fighterSprites ?? [];
  const fighter = fighterProp ?? dashboardContext?.fighter;
  const createMatch = useCreateMatch();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<EntryMode>('single');
  const [games, setGames] = useState<SetGameValues[]>([]);
  // UXFB-01: `createMatch.isPending` flickers on/off between each sequential
  // per-game mutation in `handleSetSubmit` below, which would flicker the
  // save button's spinner in and out mid-save. This tracks the whole
  // multi-game submit as one stable pending window instead.
  const [savingSet, setSavingSet] = useState(false);

  const form = useMatchForm(buildDefaultValues(fighter?.id ?? fighterSprites[0]?.id ?? 0), {
    requireVod,
  });
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
      const created = await createMatch.mutateAsync(input);
      onCreated?.(created);
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
    setSavingSet(true);
    try {
      for (const payload of payloads) {
        const created = await createMatch.mutateAsync(payload);
        savedCount += 1;
        onCreated?.(created);
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
    } finally {
      setSavingSet(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button disabled={fighterSprites.length === 0} variant={triggerVariant} size={triggerSize}>
          {triggerLabel ?? t('dashboard.addMatch.title')}
        </Button>
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
            if (!value) return;
            const nextMode = value as EntryMode;
            if (nextMode === mode) return;
            // First-switch seeding (not two-way live sync, per CONTEXT): carry
            // the fighter/opponent-fighter/opponent-name the user actually
            // selected in the mode they're leaving onto the mode they're
            // entering, instead of exposing that other form's untouched
            // default (opponentFighterId defaults to the alphabetically-first
            // sprite, Banjo & Kazooie, in both forms).
            if (nextMode === 'set') {
              const { fighterId, opponentFighterId, opponentName } = form.getValues();
              setForm.setValue('fighterId', fighterId);
              setForm.setValue('opponentFighterId', opponentFighterId);
              setForm.setValue('opponentName', opponentName);
            } else {
              const { fighterId, opponentFighterId, opponentName } = setForm.getValues();
              form.setValue('fighterId', fighterId);
              form.setValue('opponentFighterId', opponentFighterId);
              form.setValue('opponentName', opponentName);
            }
            setMode(nextMode);
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
            <MatchFormFields form={form} fighterSprites={fighterSprites} requireVod={requireVod} />
            <DialogFooter className="mt-4">
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                {t('common.cancel')}
              </Button>
              <PendingButton type="submit" pending={createMatch.isPending}>
                {t('common.save')}
              </PendingButton>
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
                <PendingButton
                  type="submit"
                  pending={savingSet}
                  pendingToastLabel={t('shared.pending.saving')}
                >
                  {t('dashboard.addMatch.saveSet')}
                </PendingButton>
              </DialogFooter>
            }
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
