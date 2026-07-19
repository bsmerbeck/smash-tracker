import type { ReactNode } from 'react';
import { useProfile } from '@/hooks/useProfile';
import { CoachingModeDisabled } from './CoachingModeDisabled';

/**
 * Phase 11 walkthrough fix round 1 (FB-3): wraps both `/coach` (the hub)
 * and `/coach/:clientId/*` (the workspace) in `AppRouter` — coaching mode
 * is opt-in via Profile > Account, so neither route renders its real
 * content until `useProfile()`'s `coachingModeEnabled` reads `true`.
 * While the profile is still loading, renders nothing rather than a
 * flash of the disabled state (mirrors `ProtectedRoute`'s own
 * loading-renders-nothing convention) — the profile query is normally
 * already warm from `ActiveSubjectSync`/Topbar mounting first.
 */
export function CoachingModeGate({ children }: { children: ReactNode }) {
  const { data: profile, isLoading } = useProfile();

  if (isLoading) {
    return null;
  }

  if (profile?.coachingModeEnabled !== true) {
    return <CoachingModeDisabled />;
  }

  return <>{children}</>;
}
