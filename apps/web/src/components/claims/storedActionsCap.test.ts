import { describe, expect, it, vi } from 'vitest';
import type { ClaimAtomRecord, StoredScoutReport } from '@smash-tracker/shared';
import {
  ACTION_CLAIM_MAP,
  FAMILIARITY_CLAIM,
  PRACTICE_CLAIM,
  STAGE_HABIT_CLAIM,
} from '@/test/actionFixtures';
import { resolveStoredActions } from './storedActions';

/**
 * Code review WEB-05: `resolveStoredActions` walks `ACTION_SLOT_KEYS` and picks
 * at most one candidate per slot, so with the shipped three keys the result
 * can never exceed `MAX_RECOMMENDED_ACTIONS` whether or not its own
 * `.slice(0, MAX_RECOMMENDED_ACTIONS)` guard exists — a "never more than three"
 * assertion over the real keys cannot fail. This file widens the slot-key
 * list to FOUR (a stub of the one shared constant, nothing else) and feeds
 * four resolvable slots, so the defence-in-depth cap is the only thing
 * standing between the input and a fourth row. Deleting the slice fails it.
 */
vi.mock('@smash-tracker/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@smash-tracker/shared')>();
  return { ...actual, ACTION_SLOT_KEYS: [...actual.ACTION_SLOT_KEYS, 'action4'] as const };
});

/** Mario (1) vs Link (3), 1–6 — a second losing matchup, licensing a fourth distinct candidate. */
const SECOND_PRACTICE_CLAIM: ClaimAtomRecord = {
  ...PRACTICE_CLAIM,
  id: 'c06',
  subject: { myFighterId: 1, opponentFighterId: 3 },
  value: { kind: 'record', wins: 1, losses: 6, games: 7 },
  evidenceIds: ['cmr-f1-g3'],
  sample: { ...PRACTICE_CLAIM.sample, rawSampleSize: 7, eligibleDenominator: 7 },
};

const FOUR_SLOTS = {
  action1: { actionId: 'a01', claimId: PRACTICE_CLAIM.id },
  action2: { actionId: 'a02', claimId: STAGE_HABIT_CLAIM.id },
  action3: { actionId: 'a03', claimId: FAMILIARITY_CLAIM.id },
  action4: { actionId: 'a04', claimId: SECOND_PRACTICE_CLAIM.id },
} as unknown as NonNullable<StoredScoutReport['actions']>;

const CLAIMS = { ...ACTION_CLAIM_MAP, [SECOND_PRACTICE_CLAIM.id]: SECOND_PRACTICE_CLAIM };

describe('resolveStoredActions cap (code review WEB-05)', () => {
  it('control: every one of the four slots resolves on its own, so the input really carries four rows', () => {
    const resolvedClaimIds = [
      PRACTICE_CLAIM.id,
      STAGE_HABIT_CLAIM.id,
      FAMILIARITY_CLAIM.id,
      SECOND_PRACTICE_CLAIM.id,
    ].map((claimId) => {
      const { actions } = resolveStoredActions({
        actions: { action1: { actionId: 'a01', claimId } },
        claims: CLAIMS,
      });
      expect(actions, claimId).toHaveLength(1);
      return actions[0]!.id;
    });
    expect(new Set(resolvedClaimIds).size).toBe(4);
  });

  it('draws at most three actions from four resolvable slots, keeping the first three in slot order', () => {
    const { actions } = resolveStoredActions({ actions: FOUR_SLOTS, claims: CLAIMS });
    expect(actions).toHaveLength(3);
    expect(actions.map((action) => action.claimIds[0])).toEqual([
      PRACTICE_CLAIM.id,
      STAGE_HABIT_CLAIM.id,
      FAMILIARITY_CLAIM.id,
    ]);
  });
});
