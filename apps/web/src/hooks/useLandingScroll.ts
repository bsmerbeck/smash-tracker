import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router';

/**
 * WR-02 (39.1-REVIEW): the ONE landing-scroll for a drill terminus.
 * `AppRouter.tsx` uses `BrowserRouter`, which performs no hash scroll of its
 * own, so an effect after mount is the only place the scroll can land.
 *
 * Scrolls `#anchorId` into view once per navigation (`location.key`) when
 * the hash names it AND the page reports `ready` (its data has landed and
 * the terminus is mounted). The previous per-page effects keyed only on the
 * location, so on a cold load / refresh / shared door URL they ran once
 * against the loading skeleton, found no element, and never re-ran when the
 * data arrived. The ref records a navigation as handled only once the
 * element was actually found, so a not-yet-mounted terminus retries on the
 * next `ready` change instead of being skipped.
 */
export function useLandingScroll({ anchorId, ready }: { anchorId: string; ready: boolean }): void {
  const location = useLocation();
  const scrolledForKey = useRef<string | null>(null);
  useEffect(() => {
    if (!ready || location.hash !== `#${anchorId}`) return;
    if (scrolledForKey.current === location.key) return;
    const target = document.getElementById(anchorId);
    if (!target) return;
    scrolledForKey.current = location.key;
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [ready, anchorId, location.key, location.hash]);
}
