import type { PrepBriefStatus } from '@smash-tracker/shared';

/**
 * Phase 28 (REV-01, 28-CONTEXT.md "Conversion mechanics", owner invariant
 * 5): widens the Phase 26 single-value switch to `'prep' | 'review'`. The
 * SOLE authority for this decision is `PrepBriefStatus.reviewAt` — the
 * server's EFFECTIVE conversion moment (the frozen `brief.reviewAt` once the
 * write-once transaction has committed, otherwise the server-derived
 * candidate computed from the registry row; see `prepBriefStatusSchema`'s
 * doc comment, 28-04's GET handler). The client NEVER re-derives review mode
 * from raw entry dates (`entry.firstSetAt`/`lastSetAt`/`eventDate`) — doing
 * so was the owner's REJECTED original proposal (28-CONTEXT.md "⚠ ONE
 * CORRECTION"), because a manually-entered event's date can resolve to the
 * start of the selected day, which would flip a tournament that is only
 * STARTING into a "post-event" review. Reading only the server's answer is
 * also what makes a converted surface un-flippable back to prep: once
 * `reviewAt` is frozen server-side, a later sync that moves a synced entry's
 * `lastSetAt` into the future can never change what this function returns,
 * because the registry row is never consulted again once the freeze exists
 * (the freeze itself rides the existing mount activate-or-reopen mutation,
 * server-side, per 28-04).
 *
 * Plan 39-12 (PREP-05, review C1-H6): moved here verbatim from
 * `PrepBriefPage.tsx` so the three debrief entry points (dashboard slot,
 * opponent hub card, tournament detail CTA) can prove their affordance
 * lands where it promises by driving THIS predicate — the destination
 * page's own — rather than a copy of it. `now` defaults to `Date.now()`,
 * which is exactly the pre-move behaviour for the page's one-argument call.
 */
export type PrepSurfaceMode = 'prep' | 'review';

export function derivePrepSurfaceMode(
  status: PrepBriefStatus,
  now: number = Date.now(),
): PrepSurfaceMode {
  return status.activated && status.reviewAt !== undefined && status.reviewAt <= now
    ? 'review'
    : 'prep';
}
