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
import { alphaSpriteList } from '@/components/match-form/MatchForm';
import { NO_SELECTION_STAGE } from '@/data/stages';
import {
  STANDARD_ONLINE_STAGE_IDS,
  getGroupedStageOptions,
  stageOptions,
} from '@/lib/stageOptions';
import { StageSelectGroups, StageSelectValue } from '@/components/StageSelectGroups';
import { useStageFavorites, useToggleStageFavorite } from '@/hooks/useStageFavorites';
import { useCreateMatch } from '@/hooks/useCreateMatch';
import { parseGspNumber } from '../lib/parseGspNumber';
import { calibrationFromSettings, estimateMmrAt } from '../lib/gspMmrModel';

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

  function resetForNextMatch(nextGsp: number) {
    // The opponent's character is deliberately PERSISTED: quickplay rematches
    // against the same player are common, so the next log usually needs only
    // Win/Loss + the new GSP. Result resets (must be chosen every match),
    // GSP prefills with the reading just entered, stage resets (it changes
    // game to game and is optional anyway).
    setResult(undefined);
    setGspInput(String(nextGsp));
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
    const gsp = parseGspNumber(gspInput);
    if (gsp === null) {
      toast.error(t('gsp.logger.invalidGsp'));
      return;
    }

    const stage = stageOptions.find((s) => s.id === stageId) ?? NO_SELECTION_STAGE;
    const delta = lastGsp !== null ? gsp - lastGsp : null;

    // V10.1: alongside the raw GSP delta, estimate the hidden-MMR delta by
    // converting both readings through the reverse-engineered model — each at
    // its own log time (t drifts). Only shown when BOTH convert "cleanly"
    // (land on the ±1-GSP-accurate main curve); tail readings are too
    // approximate for a single-match delta to mean anything.
    const calibration = calibrationFromSettings(settings);
    let mmrDeltaLabel = '';
    if (lastPoint !== null) {
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
        gsp,
      });
      const deltaLabel =
        delta === null ? '' : ` (${delta >= 0 ? '+' : ''}${delta.toLocaleString()} GSP)`;
      toast.success(
        `${t('gsp.logger.logged', { gsp: gsp.toLocaleString() })}${deltaLabel}${mmrDeltaLabel}`,
      );
      resetForNextMatch(gsp);
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
            {fighter.name}
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
                    {s.name}
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
      </CardContent>
    </Card>
  );
}
