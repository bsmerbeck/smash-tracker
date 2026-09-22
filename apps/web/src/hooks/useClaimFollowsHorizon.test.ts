import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { HorizonKey } from '@smash-tracker/shared';
import { useClaimFollowsHorizon } from './useClaimFollowsHorizon';

type Props = {
  horizon: HorizonKey;
  horizonLoading: boolean;
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
      { horizon: 'last30', horizonLoading: false, claimId: 'formNow:account:last30' },
      ['formNow:account:last90'],
    );
    rerender({ horizon: 'last90', horizonLoading: false, claimId: 'formNow:account:last30' });
    expect(rewriteClaim).toHaveBeenCalledExactlyOnceWith('formNow:account:last90');
  });

  it('drops the claim when the new horizon has no such insight', () => {
    const { rerender, rewriteClaim } = setup(
      { horizon: 'last30', horizonLoading: false, claimId: 'formNow:account:last30' },
      [],
    );
    rerender({ horizon: 'lastEvent', horizonLoading: false, claimId: 'formNow:account:last30' });
    expect(rewriteClaim).toHaveBeenCalledExactlyOnceWith(null);
  });

  it('never treats the loading placeholder settling as a user change (a shared door URL arrives untouched)', () => {
    const { rerender, rewriteClaim } = setup(
      { horizon: 'last30', horizonLoading: true, claimId: 'formNow:account:last30' },
      ['formNow:account:last90'],
    );
    rerender({ horizon: 'last90', horizonLoading: false, claimId: 'formNow:account:last30' });
    expect(rewriteClaim).not.toHaveBeenCalled();
  });

  it('leaves a claim that does not end in the previous horizon alone, and does nothing with no claim', () => {
    const { rerender, rewriteClaim } = setup(
      { horizon: 'last30', horizonLoading: false, claimId: 'formNow:account:last90' },
      ['formNow:account:last90'],
    );
    rerender({ horizon: 'last90', horizonLoading: false, claimId: 'formNow:account:last90' });
    rerender({ horizon: 'last30', horizonLoading: false, claimId: undefined });
    expect(rewriteClaim).not.toHaveBeenCalled();
  });
});
