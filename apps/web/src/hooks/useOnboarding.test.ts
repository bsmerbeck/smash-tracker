import { describe, expect, it } from 'vitest';
import {
  intentDestination,
  isUnambiguousOrigin,
  originIntentHint,
  resolveOnboardingRoute,
} from './useOnboarding';

describe('intentDestination', () => {
  it('maps every onboarding intent to an existing AppRouter path', () => {
    expect(intentDestination('review_vod')).toBe('/vod');
    expect(intentDestination('track_improvement')).toBe('/fighter-analysis');
    expect(intentDestination('prepare')).toBe('/tournaments');
    expect(intentDestination('scout')).toBe('/scout');
    expect(intentDestination('coach_clients')).toBe('/coach');
  });
});

describe('originIntentHint / isUnambiguousOrigin', () => {
  it('D-02: vodShare and recap are the two unambiguous origins', () => {
    expect(isUnambiguousOrigin('vodShare')).toBe(true);
    expect(isUnambiguousOrigin('recap')).toBe(true);
    expect(isUnambiguousOrigin('coachReview')).toBe(false);
  });

  it('maps vodShare/coachReview to review_vod and recap to prepare', () => {
    expect(originIntentHint('vodShare')).toBe('review_vod');
    expect(originIntentHint('coachReview')).toBe('review_vod');
    expect(originIntentHint('recap')).toBe('prepare');
  });
});

describe('resolveOnboardingRoute', () => {
  it('a saved intent always wins, routing to its guided path', () => {
    expect(
      resolveOnboardingRoute({
        onboardingIntent: 'scout',
        isNewAccount: true,
        origin: { kind: 'vodShare', returnPath: '/s/abc', timestamp: Date.now() },
      }),
    ).toEqual({ to: '/scout' });
  });

  it('a returning account (not new) with no saved intent lands on /dashboard, ignoring any origin', () => {
    expect(
      resolveOnboardingRoute({
        onboardingIntent: null,
        isNewAccount: false,
        origin: { kind: 'vodShare', returnPath: '/s/abc', timestamp: Date.now() },
      }),
    ).toEqual({ to: '/dashboard' });
  });

  it('a new account with an unambiguous origin auto-saves the mapped intent and skips straight to the guided path', () => {
    expect(
      resolveOnboardingRoute({
        onboardingIntent: null,
        isNewAccount: true,
        origin: { kind: 'recap', returnPath: '/s/def', timestamp: Date.now() },
      }),
    ).toEqual({ to: '/tournaments', autoSaveIntent: 'prepare' });
  });

  it('a new account with an ambiguous origin routes to /welcome with the mapped intent pre-selected, never auto-saved', () => {
    expect(
      resolveOnboardingRoute({
        onboardingIntent: null,
        isNewAccount: true,
        origin: { kind: 'coachReview', returnPath: '/r/xyz', timestamp: Date.now() },
      }),
    ).toEqual({ to: '/welcome', state: { preselect: 'review_vod' } });
  });

  it('a new account with no origin and no saved intent gets the plain chooser', () => {
    expect(
      resolveOnboardingRoute({ onboardingIntent: null, isNewAccount: true, origin: null }),
    ).toEqual({ to: '/welcome' });
  });
});
