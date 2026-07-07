import { useState } from 'react';
import { toast } from 'sonner';
import type { Fighter } from '@smash-tracker/shared';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { alphaSpriteList } from '@/components/match-form/MatchForm';
import { NO_SELECTION_STAGE } from '@/data/stages';
import { alphaStageList, stageOptions } from '@/lib/stageOptions';
import { StageOption } from '@/components/StageOption';
import { useCreateMatch } from '@/hooks/useCreateMatch';
import { parseGspNumber } from '../lib/parseGspNumber';

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
 * next match (keeping "your fighter" sticky) and shows the GSP delta.
 */
export function QuickLogger({ fighter, lastGsp }: { fighter: Fighter; lastGsp: number | null }) {
  const createMatch = useCreateMatch();
  const [opponentFighterId, setOpponentFighterId] = useState<number | undefined>(undefined);
  const [result, setResult] = useState<'win' | 'loss' | undefined>(undefined);
  const [gspInput, setGspInput] = useState<string>(lastGsp !== null ? String(lastGsp) : '');
  const [stageId, setStageId] = useState<number>(NO_SELECTION_STAGE.id);
  const [submitting, setSubmitting] = useState(false);

  function resetForNextMatch(nextGsp: number) {
    setOpponentFighterId(undefined);
    setResult(undefined);
    setGspInput(String(nextGsp));
    setStageId(NO_SELECTION_STAGE.id);
  }

  async function handleSubmit() {
    if (!opponentFighterId) {
      toast.error("Choose the opponent's character.");
      return;
    }
    if (!result) {
      toast.error('Mark this match as a win or loss.');
      return;
    }
    const gsp = parseGspNumber(gspInput);
    if (gsp === null) {
      toast.error('Enter the GSP shown after the match — commas are fine, e.g. 10,300,000.');
      return;
    }

    const stage = stageOptions.find((s) => s.id === stageId) ?? NO_SELECTION_STAGE;
    const delta = lastGsp !== null ? gsp - lastGsp : null;

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
        delta === null ? '' : ` (${delta >= 0 ? '+' : ''}${delta.toLocaleString()})`;
      toast.success(`Match logged! GSP ${gsp.toLocaleString()}${deltaLabel}`);
      resetForNextMatch(gsp);
    } catch {
      toast.error('Failed to log the match. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Quick Logger
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
              Opponent Character
            </label>
            <Select
              value={opponentFighterId !== undefined ? String(opponentFighterId) : undefined}
              onValueChange={(v) => setOpponentFighterId(Number(v))}
            >
              <SelectTrigger id="gsp-logger-opponent" className="w-full">
                <SelectValue placeholder="Select a character" />
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
            <span className="text-sm font-medium">Result</span>
            <ToggleGroup
              type="single"
              variant="outline"
              value={result ?? ''}
              onValueChange={(value) => {
                if (value === 'win' || value === 'loss') setResult(value);
              }}
            >
              <ToggleGroupItem value="win" aria-label="Win">
                Win
              </ToggleGroupItem>
              <ToggleGroupItem value="loss" aria-label="Loss">
                Loss
              </ToggleGroupItem>
            </ToggleGroup>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium" htmlFor="gsp-logger-gsp">
              GSP After Match
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
              placeholder="e.g. 9,420,000"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium" htmlFor="gsp-logger-stage">
              Stage (optional)
            </label>
            <Select value={String(stageId)} onValueChange={(v) => setStageId(Number(v))}>
              <SelectTrigger id="gsp-logger-stage" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={String(NO_SELECTION_STAGE.id)}>
                  {NO_SELECTION_STAGE.name}
                </SelectItem>
                <SelectGroup>
                  <SelectLabel>All stages</SelectLabel>
                  {alphaStageList.map((s) => (
                    <SelectItem key={s.id} value={String(s.id)}>
                      <StageOption stage={s} />
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
        </div>

        <Button type="button" onClick={() => void handleSubmit()} disabled={submitting}>
          {submitting ? 'Logging...' : 'Log Match'}
        </Button>
      </CardContent>
    </Card>
  );
}
