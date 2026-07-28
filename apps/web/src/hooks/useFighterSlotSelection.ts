import { useState } from 'react';
import type { FighterSelection } from '@smash-tracker/shared';
import { useEffectiveSubject } from './useEffectiveSubject';

/**
 * 260726-r4 (P0 data-loss fix): seeds a fighter slot's on-page selection
 * from the server exactly once per subject — never on every background
 * refetch. The previous `CharacterSelectScreen` implementation reseeded
 * `selectedIds` whenever the `fighters` query object changed reference
 * (including a refetch triggered by a SIBLING panel's save on a combined
 * page), which silently discarded in-progress, unsaved edits. Returns
 * `undefined` until this subject's server value has genuinely been
 * observed, so callers can distinguish "not yet known" from "known empty"
 * (the `?? []` coercion this quick task removes elsewhere).
 *
 * Reseeds when the active subject changes (`useEffectiveSubject()`) so
 * navigating between two different clients'/workspaces' fighter pages —
 * without necessarily unmounting this component — never leaks one
 * subject's selection into another's.
 */
export function useFighterSlotSelection(
  fighters: FighterSelection | undefined,
  slot: 'primary' | 'secondary',
): [number[] | undefined, (ids: number[]) => void] {
  const subject = useEffectiveSubject();
  const resetKey = `${subject.mode}:${subject.clientId ?? ''}`;

  const [seededFor, setSeededFor] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<number[] | undefined>(undefined);

  if (seededFor !== resetKey) {
    setSeededFor(resetKey);
    setSelectedIds(fighters ? fighters[slot] : undefined);
  } else if (fighters && selectedIds === undefined) {
    setSelectedIds(fighters[slot]);
  }

  return [selectedIds, setSelectedIds];
}
