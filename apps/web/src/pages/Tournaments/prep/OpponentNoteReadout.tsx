import { useTranslation } from 'react-i18next';
import type { OpponentNote } from '@smash-tracker/shared';
import { StageOption } from '@/components/StageOption';
import { alphaStageList } from '@/lib/stageOptions';

export interface OpponentNoteReadoutProps {
  /** The saved scouting note for this opponent, or undefined when none exists. */
  note: OpponentNote | undefined;
}

/**
 * Read-only rendering of a stored opponent scouting note — habits/watchFor
 * as verbatim text, banThese as a wrapped list of stage chips. Deliberately
 * identical in shape to `TendenciesCard`'s own read-only branch (same
 * elements, same classes, same i18n keys): the same stored field deserves
 * the same label everywhere in the app. `TendenciesCard.tsx` itself is not
 * touched — the opponents surface keeps its existing behavior.
 *
 * The three stored strings/ids render as-is. Never parse, tokenize, split,
 * or otherwise derive tags from the free text (D-17) — "improve the notes
 * rendering by extracting tags" is exactly the plausible-sounding future
 * change this decision forbids.
 */
export function OpponentNoteReadout({ note }: OpponentNoteReadoutProps) {
  const { t } = useTranslation();

  const hasContent = Boolean(note?.habits || note?.watchFor || (note?.banThese?.length ?? 0) > 0);
  if (!hasContent) {
    return null;
  }

  return (
    <>
      {note?.habits && (
        <div>
          <h4 className="text-sm font-medium text-muted-foreground">
            {t('opponents.tendencies.habits')}
          </h4>
          <p className="whitespace-pre-wrap text-sm">{note.habits}</p>
        </div>
      )}
      {note?.banThese && note.banThese.length > 0 && (
        <div>
          <h4 className="mb-1 text-sm font-medium text-muted-foreground">
            {t('opponents.tendencies.banTheseView')}
          </h4>
          <ul className="flex flex-wrap gap-2" aria-label={t('opponents.tendencies.banViewAria')}>
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
          <h4 className="text-sm font-medium text-muted-foreground">
            {t('opponents.tendencies.watchFor')}
          </h4>
          <p className="whitespace-pre-wrap text-sm">{note.watchFor}</p>
        </div>
      )}
    </>
  );
}
