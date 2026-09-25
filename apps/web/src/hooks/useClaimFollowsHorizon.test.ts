import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { HorizonKey } from '@smash-tracker/shared';
import { useClaimFollowsHorizon } from './useClaimFollowsHorizon';

type Props = {
  horizon: HorizonKey;
  horizonLoading: boolean;
  horizonChangeCount: number;
  claimId: string | undefined;
};

function setup(initial: Props, known: string[]) {
  const rewriteClaim = vi.fn();
  const hasClaim = (id: string) => known.includes(id);
  const hook = renderHook(
    (props: Props) => useClaimFollowsHorizon({ ...props, hasClaim, rewriteClaim }),
    {
      initialProps: initial,
    },
  );
  return { ...hook, rewriteClaim };
}

describe('useClaimFollowsHorizon (WR-01, 39.1-REVIEW)', () => {
  it('re-points a claim to the same insight at the new horizon when the page can resolve it', () => {
    const { rerender, rewriteClaim } = setup(
      {
        horizon: 'last30',
        horizonLoading: false,
        horizonChangeCount: 0,
        claimId: 'formNow:account:last30',
      },
      ['formNow:account:last90'],
    );
    rerender({
      horizon: 'last90',
      horizonLoading: false,
      horizonChangeCount: 1,
      claimId: 'formNow:account:last30',
    });
    expect(rewriteClaim).toHaveBeenCalledExactlyOnceWith('formNow:account:last90');
  });

  // Iteration 2 (WR-01): one rule on every page — an unresolvable claim is
  // left in place for the terminus's explicit "not applied" notice, never
  // silently dropped from the URL.
  it('leaves the claim in place when the new horizon has no such insight', () => {
    const { rerender, rewriteClaim } = setup(
      {
        horizon: 'last30',
        horizonLoading: false,
        horizonChangeCount: 0,
        claimId: 'formNow:account:last30',
      },
      [],
    );
    rerender({
      horizon: 'lastEvent',
      horizonLoading: false,
      horizonChangeCount: 1,
      claimId: 'formNow:account:last30',
    });
    expect(rewriteClaim).not.toHaveBeenCalled();
  });

  it('never treats the loading placeholder settling as a user change (a shared door URL arrives untouched)', () => {
    const { rerender, rewriteClaim } = setup(
      {
        horizon: 'last30',
        horizonLoading: true,
        horizonChangeCount: 0,
        claimId: 'formNow:account:last30',
      },
      ['formNow:account:last90'],
    );
    rerender({
      horizon: 'last90',
      horizonLoading: false,
      horizonChangeCount: 0,
      claimId: 'formNow:account:last30',
    });
    expect(rewriteClaim).not.toHaveBeenCalled();
  });

  // Iteration 2 (WR-01): `useHorizon` can settle on the default before auth
  // resolves (no storage key yet) and then land the persisted value. That
  // settled-to-settled move carries no explicit change, so an arriving door
  // URL must not be re-pointed to a window its sender did not choose.
  it('never treats the persisted value landing after a settled default as a user change', () => {
    const { rerender, rewriteClaim } = setup(
      {
        horizon: 'last30',
        horizonLoading: false,
        horizonChangeCount: 0,
        claimId: 'formNow:account:last30',
      },
      ['formNow:account:last90'],
    );
    rerender({
      horizon: 'last90',
      horizonLoading: false,
      horizonChangeCount: 0,
      claimId: 'formNow:account:last30',
    });
    expect(rewriteClaim).not.toHaveBeenCalled();
  });

  it('leaves a claim that does not end in the previous horizon alone, and does nothing with no claim', () => {
    const { rerender, rewriteClaim } = setup(
      {
        horizon: 'last30',
        horizonLoading: false,
        horizonChangeCount: 0,
        claimId: 'formNow:account:last90',
      },
      ['formNow:account:last90'],
    );
    rerender({
      horizon: 'last90',
      horizonLoading: false,
      horizonChangeCount: 1,
      claimId: 'formNow:account:last90',
    });
    rerender({
      horizon: 'last30',
      horizonLoading: false,
      horizonChangeCount: 2,
      claimId: undefined,
    });
    expect(rewriteClaim).not.toHaveBeenCalled();
  });
});
