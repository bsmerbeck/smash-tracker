import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type { StoredScoutReport } from '@smash-tracker/shared';
import {
  ACTION_CLAIM_MAP,
  ACTION_SLOTS,
  FAMILIARITY_CLAIM,
  PRACTICE_CLAIM,
  STAGE_HABIT_CLAIM,
  VOD_ONLY_CLAIM,
} from '@/test/actionFixtures';
import { PaidRecommendedActionsCard } from './PaidRecommendedActionsCard';
import { RecommendedActionsCard } from './RecommendedActionsCard';
import { resolveStoredActions, toClaimAtom } from './storedActions';

/**
 * Phase 39 (plan 39-11, RPT-09 / D-12): the PAID recommended-actions block.
 * It composes the free module's rows unchanged; the only paid-side addition
 * is the 39.1 primary-door emphasis on the first row. Host mounts are
 * asserted beside their hosts (`ScoutAiReportCard.test.tsx`,
 * `PostEventSynthesisCard.test.tsx`).
 */

type Slots = NonNullable<StoredScoutReport['actions']>;

function renderPaid(actions: Slots | null | undefined, claims = ACTION_CLAIM_MAP) {
  return render(
    <MemoryRouter initialEntries={['/scout']}>
      <PaidRecommendedActionsCard actions={actions} claims={claims} />
    </MemoryRouter>,
  );
}

function rows(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[data-action-row]'));
}

describe('PaidRecommendedActionsCard', () => {
  it('draws the model’s three slots in slot order, each through its stored claim, with one door per row', () => {
    const { container } = renderPaid(ACTION_SLOTS);
    const drawn = rows(container);
    expect(drawn.map((row) => row.dataset.actionKind)).toEqual([
      'matchup_practice',
      'drill',
      'drill',
    ]);
    expect(screen.getByText('Practice Mario vs Donkey Kong')).toBeInTheDocument();
    expect(screen.getByText('Drill: your game plan on Big Battlefield')).toBeInTheDocument();
    expect(screen.getByText('Drill: learn the Link matchup')).toBeInTheDocument();
    for (const row of drawn) {
      expect(within(row).getAllByRole('link')).toHaveLength(1);
    }
  });

  it('follows the slot order the model chose, not the engine’s ranking', () => {
    const { container } = renderPaid({
      action1: { actionId: 'a01', claimId: FAMILIARITY_CLAIM.id },
      action2: { actionId: 'a02', claimId: PRACTICE_CLAIM.id },
    });
    expect(rows(container).map((row) => row.dataset.actionKind)).toEqual([
      'drill',
      'matchup_practice',
    ]);
  });

  it('gives only the FIRST row the primary door (the 39.1 convention); every other door stays outline', () => {
    const { container } = renderPaid(ACTION_SLOTS);
    const variants = rows(container).map((row) =>
      row.querySelector('[data-slot="button"]')?.getAttribute('data-variant'),
    );
    expect(variants).toEqual(['default', 'outline', 'outline']);
  });

  it('draws the same row shell as the free card', () => {
    const paid = rows(renderPaid(ACTION_SLOTS).container);
    const resolved = resolveStoredActions({ actions: ACTION_SLOTS, claims: ACTION_CLAIM_MAP });
    const free = rows(
      render(
        <MemoryRouter>
          <RecommendedActionsCard actions={resolved.actions} claims={resolved.claims} />
        </MemoryRouter>,
      ).container,
    );
    expect(paid.map((row) => row.className)).toEqual(free.map((row) => row.className));
    expect(paid.map((row) => row.textContent)).toEqual(free.map((row) => row.textContent));
  });

  it('never draws a slot it cannot resolve: a missing claim, or a claim that licenses no action without VOD references', () => {
    const { container } = renderPaid({
      action1: { actionId: 'a01', claimId: 'c99' },
      action2: { actionId: 'a02', claimId: VOD_ONLY_CLAIM.id },
      action3: { actionId: 'a03', claimId: STAGE_HABIT_CLAIM.id },
    });
    const drawn = rows(container);
    expect(drawn.map((row) => row.dataset.actionKind)).toEqual(['drill']);
    expect(within(drawn[0]!).getAllByRole('link')).toHaveLength(1);
  });

  it('with no chosen slots renders the one empty sentence and no rows', () => {
    const { container } = renderPaid(undefined);
    expect(
      screen.getByText(
        'Not enough data yet to recommend a specific action — log a few more games.',
      ),
    ).toBeInTheDocument();
    expect(rows(container)).toHaveLength(0);
  });
});

describe('storedActions', () => {
  it('restores RTDB-stripped nullish members to the engine’s null shape', () => {
    const atom = toClaimAtom({
      ...STAGE_HABIT_CLAIM,
      subject: undefined,
      tier: undefined,
      sample: { ...STAGE_HABIT_CLAIM.sample, confidenceTier: undefined, dateRange: undefined },
    });
    expect(atom.subject).toEqual({
      myFighterId: null,
      opponentFighterId: null,
      stageId: null,
      opponentTag: null,
    });
    expect(atom.tier).toBeNull();
    expect(atom.sample.confidenceTier).toBeNull();
    expect(atom.sample.dateRange).toBeNull();
  });

  it('never returns more than three actions', () => {
    const { actions } = resolveStoredActions({ actions: ACTION_SLOTS, claims: ACTION_CLAIM_MAP });
    expect(actions.length).toBeLessThanOrEqual(3);
  });
});
