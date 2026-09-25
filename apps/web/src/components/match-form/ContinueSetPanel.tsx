import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { CreateMatchInput, Fighter, Match } from '@smash-tracker/shared';
import { Button } from '@/components/ui/button';
import { DialogFooter } from '@/components/ui/dialog';
import { PendingButton } from '@/components/ui/pending-button';
import { useCreateMatch } from '@/hooks/useCreateMatch';
import { useMatches } from '@/hooks/useMatches';
import {
  continueSetSharedDefaults,
  findPriorSetGames,
  matchToSetGameValues,
} from './continueSetLogic';
import { SetWizard, useSetSharedForm } from './SetWizard';
import type { SetGameValues } from './setWizardLogic';

/**
 * The continuation body rendered INSIDE the Edit Match dialog's existing
 * `DialogContent` — see `EditMatchForm`'s doc comment for why this can't be
 * a second `Dialog`: both mount points unmount `EditMatchForm` (and
 * everything it renders) the instant the edit dialog closes, so a sibling
 * dialog opened after closing this one would be destroyed before it could
 * render.
 *
 * Split into an outer panel (this component) plus an inner wizard
 * (`ContinueSetWizard`) because the wizard's form defaults depend on data
 * that arrives asynchronously and `useSetSharedForm` must not be called
 * conditionally.
 */
export function ContinueSetPanel({
  anchorMatch,
  fighterSprites,
  onBack,
  onDone,
}: {
  anchorMatch: Match;
  /** The fighters offered for "Your Fighter" — the signed-in user's primary+secondary selections. */
  fighterSprites: Fighter[];
  onBack: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const matchesQuery = useMatches();
  // Seeded once resolved data first arrives, then only ever narrowed by the
  // user's own drop/clear actions — a background refetch (a new
  // `matchesQuery.data` reference) never silently re-adds a game the user
  // just removed.
  const [lockedMatches, setLockedMatches] = useState<Match[] | null>(null);
  // Set only by the explicit "continue without context" click below — the
  // one deliberate action allowed to drop this panel into the no-context
  // path after a load failure.
  const [continueWithoutContext, setContinueWithoutContext] = useState(false);

  // Conditional setState during render (not inside a `useEffect`) — React's
  // documented pattern for "derive state once when async data arrives"
  // (https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes).
  // The condition (`lockedMatches === null`) goes false the instant this
  // fires, so it runs exactly once per mount of this panel — a later
  // refetch (a new `matchesQuery.data` reference) never re-seeds it or
  // re-adds a game the user already dropped.
  if (matchesQuery.data && lockedMatches === null) {
    setLockedMatches(findPriorSetGames(anchorMatch, matchesQuery.data));
  }

  const backFooter = (
    <DialogFooter className="mt-4">
      <Button type="button" variant="outline" onClick={onBack}>
        {t('matchForm.continueSet.back')}
      </Button>
    </DialogFooter>
  );

  // Production-gap checklist #8: an unresolved (or errored, until the user
  // opts in) matches query must never be silently coerced into "no earlier
  // games" — that would let a continuation act on an empty set it never
  // actually derived.
  if (matchesQuery.isError && !continueWithoutContext) {
    return (
      <div className="flex flex-col gap-4">
        <p data-testid="continue-set-load-failed" className="text-sm text-destructive">
          {t('matchForm.continueSet.loadFailed')}
        </p>
        <Button
          type="button"
          variant="secondary"
          className="self-start"
          onClick={() => {
            setContinueWithoutContext(true);
            setLockedMatches([]);
          }}
        >
          {t('matchForm.continueSet.continueWithoutContext')}
        </Button>
        {backFooter}
      </div>
    );
  }

  if (matchesQuery.isPending || lockedMatches === null) {
    return (
      <div className="flex flex-col gap-4">
        <p data-testid="continue-set-loading" className="text-sm text-muted-foreground">
          {t('matchForm.continueSet.loading')}
        </p>
        {backFooter}
      </div>
    );
  }

  return (
    <ContinueSetWizard
      key={anchorMatch.id}
      anchorMatch={anchorMatch}
      fighterSprites={fighterSprites}
      lockedMatches={lockedMatches}
      onDropLockedGame={(index) =>
        setLockedMatches((current) => (current ?? []).filter((_, i) => i !== index))
      }
      onClearLockedGames={() => setLockedMatches([])}
      onBack={onBack}
      onDone={onDone}
    />
  );
}

function ContinueSetWizard({
  anchorMatch,
  fighterSprites,
  lockedMatches,
  onDropLockedGame,
  onClearLockedGames,
  onBack,
  onDone,
}: {
  anchorMatch: Match;
  fighterSprites: Fighter[];
  lockedMatches: Match[];
  onDropLockedGame: (index: number) => void;
  onClearLockedGames: () => void;
  onBack: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const createMatch = useCreateMatch();
  const form = useSetSharedForm(continueSetSharedDefaults(anchorMatch, lockedMatches.length));
  const [games, setGames] = useState<SetGameValues[]>([]);
  const [savingSet, setSavingSet] = useState(false);
  const lockedGames = lockedMatches.map(matchToSetGameValues);

  /**
   * Mirrors `AddMatchForm.handleSetSubmit` exactly — same sequential-create
   * contract, same honest partial-failure reporting. `useCreateMatch()` is
   * the only permitted write path here: it resolves the workspace through
   * `useEffectiveSubject()`, which is what makes a coach's continuation land
   * in the managed client's library.
   */
  async function handleSubmit(payloads: CreateMatchInput[]) {
    if (payloads.length === 0) {
      toast.error(t('dashboard.addMatch.noGames'));
      return;
    }
    let savedCount = 0;
    setSavingSet(true);
    try {
      for (const payload of payloads) {
        await createMatch.mutateAsync(payload);
        savedCount += 1;
      }
      toast.success(t('matchForm.continueSet.added', { count: payloads.length }));
      onDone();
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
    <SetWizard
      fighterSprites={fighterSprites}
      form={form}
      games={games}
      onGamesChange={setGames}
      lockedGames={lockedGames}
      onDropLockedGame={onDropLockedGame}
      onClearLockedGames={onClearLockedGames}
      onSubmit={handleSubmit}
      footer={
        <DialogFooter className="mt-4">
          <Button type="button" variant="outline" onClick={onBack}>
            {t('matchForm.continueSet.back')}
          </Button>
          <PendingButton
            type="submit"
            pending={savingSet}
            pendingToastLabel={t('shared.pending.saving')}
          >
            {t('matchForm.continueSet.save')}
          </PendingButton>
        </DialogFooter>
      }
    />
  );
}
