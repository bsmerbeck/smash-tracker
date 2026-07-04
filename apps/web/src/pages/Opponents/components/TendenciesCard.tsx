import { useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { StageOption } from '@/components/StageOption';
import type { OpponentNote } from '@smash-tracker/shared';
import { OPPONENT_NOTE_BAN_STAGES_MAX, OPPONENT_NOTE_TEXT_MAX_LENGTH } from '@smash-tracker/shared';
import { alphaStageList } from '@/lib/stageOptions';
import { useDeleteOpponentNote, useUpsertOpponentNote } from '@/hooks/useOpponentNotes';

export interface TendenciesCardProps {
  /** Canonical opponent name the note attaches to (aliases already resolved by the caller). */
  opponent: string;
  /** The saved note for this opponent, or undefined when none has been saved yet. */
  note: OpponentNote | undefined;
}

interface DraftState {
  habits: string;
  watchFor: string;
  banThese: number[];
}

function draftFromNote(note: OpponentNote | undefined): DraftState {
  return {
    habits: note?.habits ?? '',
    watchFor: note?.watchFor ?? '',
    banThese: note?.banThese ?? [],
  };
}

/**
 * V6-W1c: opponent tendency notes — a lightweight but STRUCTURED scouting
 * card (habits / stages to ban / things to watch for), edit-in-place,
 * attached to the CANONICAL opponent name so merged aliases share one note.
 * Kept deliberately separate from the stats-driven cards above it: this is
 * the human's own scouting knowledge, not derived from match history.
 *
 * The caller (`OpponentsPage`) already keys its whole report section on
 * `profile.opponent`, so this component fully remounts (fresh `useState`
 * initializers) whenever the selected opponent changes — no effect needed to
 * reset in-progress edit state from a prop change.
 */
export function TendenciesCard({ opponent, note }: TendenciesCardProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<DraftState>(() => draftFromNote(note));
  const upsertNote = useUpsertOpponentNote();
  const deleteNote = useDeleteOpponentNote();

  const hasContent = Boolean(note?.habits || note?.watchFor || (note?.banThese?.length ?? 0) > 0);

  function startEditing() {
    setDraft(draftFromNote(note));
    setEditing(true);
  }

  function cancelEditing() {
    setDraft(draftFromNote(note));
    setEditing(false);
  }

  function handleSave() {
    upsertNote.mutate(
      {
        name: opponent,
        input: {
          habits: draft.habits.trim() || undefined,
          watchFor: draft.watchFor.trim() || undefined,
          banThese: draft.banThese.length > 0 ? draft.banThese : undefined,
        },
      },
      {
        onSuccess: () => setEditing(false),
      },
    );
  }

  function handleClear() {
    deleteNote.mutate(opponent, {
      onSuccess: () => {
        setDraft(draftFromNote(undefined));
        setEditing(false);
      },
    });
  }

  const banStageOptions = alphaStageList.filter((stage) => stage.id !== 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Tendencies</CardTitle>
        <CardDescription>
          Your own scouting notes for this opponent — not derived from match history.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {editing ? (
          <>
            <div className="flex flex-col gap-2">
              <Label htmlFor="tendencies-habits">Habits</Label>
              <Textarea
                id="tendencies-habits"
                placeholder="Opening habits, punish routes, recovery mixups..."
                value={draft.habits}
                maxLength={OPPONENT_NOTE_TEXT_MAX_LENGTH}
                onChange={(e) => setDraft((d) => ({ ...d, habits: e.target.value }))}
                rows={3}
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label>Ban these (max {OPPONENT_NOTE_BAN_STAGES_MAX})</Label>
              <ToggleGroup
                type="multiple"
                variant="outline"
                value={draft.banThese.map(String)}
                onValueChange={(next) => {
                  const ids = next.map(Number);
                  if (ids.length > OPPONENT_NOTE_BAN_STAGES_MAX) {
                    return;
                  }
                  setDraft((d) => ({ ...d, banThese: ids }));
                }}
                aria-label="Stages to ban against this opponent"
                className="flex-wrap justify-start gap-2"
              >
                {banStageOptions.map((stage) => (
                  <ToggleGroupItem
                    key={stage.id}
                    value={String(stage.id)}
                    aria-label={stage.name}
                    className="h-auto rounded-md border py-1"
                  >
                    <StageOption stage={stage} />
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="tendencies-watch-for">Watch for</Label>
              <Textarea
                id="tendencies-watch-for"
                placeholder="Reads, mind games, tech chases to expect next set..."
                value={draft.watchFor}
                maxLength={OPPONENT_NOTE_TEXT_MAX_LENGTH}
                onChange={(e) => setDraft((d) => ({ ...d, watchFor: e.target.value }))}
                rows={3}
              />
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" onClick={handleSave} disabled={upsertNote.isPending}>
                {upsertNote.isPending ? 'Saving...' : 'Save'}
              </Button>
              <Button type="button" variant="outline" onClick={cancelEditing}>
                Cancel
              </Button>
              {hasContent && (
                <Button
                  type="button"
                  variant="ghost"
                  className="text-destructive hover:text-destructive"
                  disabled={deleteNote.isPending}
                  onClick={handleClear}
                >
                  Delete note
                </Button>
              )}
            </div>
          </>
        ) : hasContent ? (
          <>
            {note?.habits && (
              <div>
                <h4 className="text-sm font-medium text-muted-foreground">Habits</h4>
                <p className="whitespace-pre-wrap text-sm">{note.habits}</p>
              </div>
            )}
            {note?.banThese && note.banThese.length > 0 && (
              <div>
                <h4 className="mb-1 text-sm font-medium text-muted-foreground">Ban these</h4>
                <ul className="flex flex-wrap gap-2" aria-label="Stages to ban">
                  {note.banThese.map((stageId) => {
                    const stage = alphaStageList.find((s) => s.id === stageId);
                    if (!stage) {
                      return null;
                    }
                    return (
                      <li key={stageId} className="rounded-md border px-2 py-1 text-sm">
                        <StageOption stage={stage} />
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
            {note?.watchFor && (
              <div>
                <h4 className="text-sm font-medium text-muted-foreground">Watch for</h4>
                <p className="whitespace-pre-wrap text-sm">{note.watchFor}</p>
              </div>
            )}
            <div className="flex items-center justify-between gap-2">
              {note?.updatedAt && (
                <p className="text-xs text-muted-foreground">
                  Saved {new Date(note.updatedAt).toLocaleString()}
                </p>
              )}
              <Button type="button" variant="outline" size="sm" onClick={startEditing}>
                Edit
              </Button>
            </div>
          </>
        ) : (
          <div className="flex flex-col items-center gap-3 py-6 text-center">
            <p className="text-sm text-muted-foreground">
              No scouting notes yet. Jot down habits, stages to ban, or things to watch for before
              your next set.
            </p>
            <Button type="button" onClick={startEditing}>
              Add a note
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
