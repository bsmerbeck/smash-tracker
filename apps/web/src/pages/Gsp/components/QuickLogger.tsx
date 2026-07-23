import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { Fighter, GspPoint, GspSettings } from '@smash-tracker/shared';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { alphaSpriteList } from '@/components/match-form/MatchForm';
import { localizedFighterName } from '@/lib/fighterNames';
import { NO_SELECTION_STAGE } from '@/data/stages';
import {
  STANDARD_ONLINE_STAGE_IDS,
  getGroupedStageOptions,
  stageOptions,
} from '@/lib/stageOptions';
import { StageSelectGroups, StageSelectValue } from '@/components/StageSelectGroups';
import { useStageFavorites, useToggleStageFavorite } from '@/hooks/useStageFavorites';
import { useCreateMatch } from '@/hooks/useCreateMatch';
import { useCreateGspReading } from '@/hooks/useGspReadings';
import { parseGspNumber } from '../lib/parseGspNumber';
import { estimateMmrAt } from '../lib/gspMmrModel';
import { useModelCalibration } from '../lib/useModelCalibration';

/**
 * Quick-log the core online-quickplay session loop: pick the opponent's
 * character, mark Win/Loss, type in the GSP shown on the post-match results
 * screen (prefilled with the last reading so most sessions only need to
 * bump/type the delta), optionally note the stage, and submit. Uses the
 * normal `POST /api/matches` path (via `useCreateMatch`) with `matchType:
 * 'quickplay'` — GSP is Nintendo's online-quickplay ranking, and
 * 'quickplay' is the existing online match-type value for it (see
 * `matchTypeValues` in packages/shared/src/match.ts) — there is no separate
 * "GSP entry" record type. After a successful save, the form resets for the
 * next match (keeping "your fighter" sticky) and shows the GSP delta, plus
 * the estimated hidden-MMR delta when both readings convert cleanly through
 * the reverse-engineered model (V10.1 — see ../lib/gspMmrModel.ts).
 *
 * V17 (community request): "Set GSP without a match" — a small dialog that
 * records a standalone calibration reading (POST /api/gsp-readings). Use it
 * at the start of a session (GSP inflates while you're away) or after
 * matches under rulesets you refuse to count: deltas and gain/loss stats
 * restart from the new baseline instead of blaming the next real match for
 * the drift (see packages/shared/src/gspReading.ts).
 */
export function QuickLogger({
  fighter,
  lastPoint,
  settings,
}: {
  fighter: Fighter;
  /** The most recent GSP reading for this fighter (with its log time), or null with no history. */
  lastPoint: GspPoint | null;
  settings: GspSettings;
}) {
  const { t } = useTranslation();
  const lastGsp = lastPoint?.gsp ?? null;
  const createMatch = useCreateMatch();
  const calibration = useModelCalibration(settings);
  const { data: stageFavorites } = useStageFavorites();
  const toggleStageFavorite = useToggleStageFavorite();
  const favoriteStageIds = stageFavorites?.stageIds;
  // No matches passed (so no "Most played" group): the quick logger has no
  // match-history dependency today, and pulling one in just for usage
  // ordering isn't worth the extra query on this deliberately light form.
  // The standard online trio IS pinned — quickplay's preferred-rules
  // matchmaking lands on BF/SBF/FD, and Small Battlefield alphabetizes far
  // from its siblings.
  const stageGroups = useMemo(
    () => getGroupedStageOptions([], favoriteStageIds, STANDARD_ONLINE_STAGE_IDS),
    [favoriteStageIds],
  );
  const [opponentFighterId, setOpponentFighterId] = useState<number | undefined>(undefined);
  const [result, setResult] = useState<'win' | 'loss' | undefined>(undefined);
  const [gspInput, setGspInput] = useState<string>(lastGsp !== null ? String(lastGsp) : '');
  const [stageId, setStageId] = useState<number>(NO_SELECTION_STAGE.id);
  const [submitting, setSubmitting] = useState(false);

  const createReading = useCreateGspReading();
  const [setGspOpen, setSetGspOpen] = useState(false);
  const [setGspDraft, setSetGspDraft] = useState('');

  function openSetGsp() {
    setSetGspDraft(lastGsp !== null ? String(lastGsp) : '');
    setSetGspOpen(true);
  }

  async function saveSetGsp() {
    const gsp = parseGspNumber(setGspDraft);
    if (gsp === null) {
      toast.error(t('gsp.logger.invalidGsp'));
      return;
    }
    try {
      await createReading.mutateAsync({ fighter_id: fighter.id, gsp });
      toast.success(t('gsp.setGsp.saved', { gsp: gsp.toLocaleString() }));
      // The new baseline is now the freshest reading — prefill the match
      // form with it, exactly like logging a match does.
      setGspInput(String(gsp));
      setSetGspOpen(false);
    } catch {
      toast.error(t('gsp.setGsp.saveFailed'));
    }
  }

  function resetForNextMatch(nextGsp: number | null) {
    // The opponent's character is deliberately PERSISTED: quickplay rematches
    // against the same player are common, so the next log usually needs only
    // Win/Loss + the new GSP. Result resets (must be chosen every match),
    // GSP prefills with the reading just entered (falling back to the
    // fighter's last known reading, or blank when neither exists), stage
    // resets (it changes game to game and is optional anyway).
    setResult(undefined);
    setGspInput(nextGsp !== null ? String(nextGsp) : '');
    setStageId(NO_SELECTION_STAGE.id);
  }

  async function handleSubmit() {
    if (!opponentFighterId) {
      toast.error(t('gsp.logger.chooseOpponent'));
      return;
    }
    if (!result) {
      toast.error(t('gsp.logger.chooseResult'));
      return;
    }

    // A blank/whitespace-only field means "no GSP for this match" — allowed.
    // Any non-blank value is still validated exactly as before.
    const trimmedGspInput = gspInput.trim();
    let gsp: number | null = null;
    if (trimmedGspInput !== '') {
      gsp = parseGspNumber(gspInput);
      if (gsp === null) {
        toast.error(t('gsp.logger.invalidGsp'));
        return;
      }
    }

    const stage = stageOptions.find((s) => s.id === stageId) ?? NO_SELECTION_STAGE;
    const delta = gsp !== null && lastGsp !== null ? gsp - lastGsp : null;

    // V10.1: alongside the raw GSP delta, estimate the hidden-MMR delta by
    // converting both readings through the reverse-engineered model — each at
    // its own log time (t drifts). Only shown when BOTH convert "cleanly"
    // (land on the ±1-GSP-accurate main curve); tail readings are too
    // approximate for a single-match delta to mean anything. Meaningless
    // without a GSP for this match, so it's skipped entirely when blank.
    let mmrDeltaLabel = '';
    if (gsp !== null && lastPoint !== null) {
      const prev = estimateMmrAt(lastPoint.gsp, lastPoint.time, calibration);
      const next = estimateMmrAt(gsp, Date.now(), calibration);
      if (prev.zone === 'main' && next.zone === 'main') {
        const mmrDelta = Math.round(next.mmr) - Math.round(prev.mmr);
        mmrDeltaLabel = ` · ≈ ${mmrDelta >= 0 ? '+' : ''}${mmrDelta} MMR`;
      }
    }

    setSubmitting(true);
    try {
      await createMatch.mutateAsync({
        fighter_id: fighter.id,
        opponent_id: opponentFighterId,
        map: { id: stage.id, name: stage.name },
        opponent: '',
        notes: '',
        matchType: 'quickplay',
        win: result === 'win',
        // Never send gsp: null/undefined — omit the field entirely when
        // blank (RTDB null-stripping convention).
        ...(gsp !== null ? { gsp } : {}),
      });
      if (gsp !== null) {
        const deltaLabel =
          delta === null ? '' : ` (${delta >= 0 ? '+' : ''}${delta.toLocaleString()} GSP)`;
        toast.success(
          `${t('gsp.logger.logged', { gsp: gsp.toLocaleString() })}${deltaLabel}${mmrDeltaLabel}`,
        );
      } else {
        toast.success(t('gsp.logger.loggedNoGsp'));
      }
      resetForNextMatch(gsp ?? lastGsp);
    } catch {
      toast.error(t('gsp.logger.logFailed'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {t('gsp.logger.title')}
          <span className="flex items-center gap-1.5 text-sm font-normal text-muted-foreground">
            <img src={fighter.url} alt="" className="size-5 object-contain" />
            {localizedFighterName(fighter.id, t)}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium" htmlFor="gsp-logger-opponent">
              {t('gsp.logger.opponentCharacter')}
            </label>
            <Select
              value={opponentFighterId !== undefined ? String(opponentFighterId) : undefined}
              onValueChange={(v) => setOpponentFighterId(Number(v))}
            >
              <SelectTrigger id="gsp-logger-opponent" className="w-full">
                <SelectValue placeholder={t('gsp.logger.selectCharacter')} />
              </SelectTrigger>
              <SelectContent>
                {alphaSpriteList.map((s) => (
                  <SelectItem key={s.id} value={String(s.id)}>
                    <img src={s.url} alt="" className="size-6 object-contain" />
                    {localizedFighterName(s.id, t)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">{t('matchForm.result')}</span>
            <ToggleGroup
              type="single"
              variant="outline"
              value={result ?? ''}
              onValueChange={(value) => {
                if (value === 'win' || value === 'loss') setResult(value);
              }}
            >
              <ToggleGroupItem value="win" aria-label={t('common.win')}>
                {t('common.win')}
              </ToggleGroupItem>
              <ToggleGroupItem value="loss" aria-label={t('common.loss')}>
                {t('common.loss')}
              </ToggleGroupItem>
            </ToggleGroup>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium" htmlFor="gsp-logger-gsp">
              {t('gsp.logger.gspAfterMatch')}
            </label>
            {/* type="text": browsers reject comma pastes into type="number"
                outright, and elitegsp.com / the game's UI both format GSP
                with thousands separators. */}
            <Input
              id="gsp-logger-gsp"
              type="text"
              inputMode="numeric"
              value={gspInput}
              onChange={(e) => setGspInput(e.target.value)}
              placeholder={t('gsp.logger.gspPlaceholder')}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium" htmlFor="gsp-logger-stage">
              {t('gsp.logger.stageOptional')}
            </label>
            <Select value={String(stageId)} onValueChange={(v) => setStageId(Number(v))}>
              <SelectTrigger id="gsp-logger-stage" className="w-full">
                <StageSelectValue stageId={stageId} />
              </SelectTrigger>
              <SelectContent>
                <StageSelectGroups groups={stageGroups} onToggleFavorite={toggleStageFavorite} />
              </SelectContent>
            </Select>
          </div>
        </div>

        <Button type="button" onClick={() => void handleSubmit()} disabled={submitting}>
          {submitting ? t('gsp.logger.logging') : t('gsp.logger.logMatch')}
        </Button>

        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="self-center text-muted-foreground"
          onClick={openSetGsp}
        >
          {t('gsp.logger.setGspButton')}
        </Button>

        <Dialog open={setGspOpen} onOpenChange={setSetGspOpen}>
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle>{t('gsp.setGsp.title')}</DialogTitle>
              <DialogDescription>{t('gsp.setGsp.description')}</DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium" htmlFor="set-gsp-value">
                {t('gsp.setGsp.label')}
              </label>
              {/* type="text": same comma-paste rationale as the match GSP field. */}
              <Input
                id="set-gsp-value"
                type="text"
                inputMode="numeric"
                value={setGspDraft}
                onChange={(e) => setSetGspDraft(e.target.value)}
                placeholder={t('gsp.logger.gspPlaceholder')}
                autoFocus
              />
            </div>
            <DialogFooter>
              <Button
                type="button"
                onClick={() => void saveSetGsp()}
                disabled={createReading.isPending}
              >
                {t('gsp.setGsp.save')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}
