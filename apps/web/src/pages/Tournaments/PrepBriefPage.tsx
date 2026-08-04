import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { PrepBriefStatus } from '@smash-tracker/shared';
import { selectReviewResultsContext, matchesForEntry } from '@smash-tracker/shared';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { useTournamentEntries } from '@/hooks/useTournamentEntries';
import { useMatches } from '@/hooks/useMatches';
import { useOpponentAliases } from '@/hooks/useOpponentAliases';
import { useOpponents } from '@/hooks/useOpponents';
import { useOpponentNotes } from '@/hooks/useOpponentNotes';
import { applyOpponentAliases } from '@/hooks/useFilteredMatches';
import { usePrepBrief, useActivatePrepBrief, useReopenPrepBrief } from '@/hooks/usePrepBrief';
import { TournamentHeader } from './components/TournamentHeader';
import { LikelyOpponentsCard } from './prep/LikelyOpponentsCard';
import { PrepChecklistCard } from './prep/PrepChecklistCard';
import { PrepPaidReportsCard } from './prepPaid/PrepPaidReportsCard';
import { ReviewModeStrip } from './postEvent/ReviewModeStrip';
import { ResultsContextCard } from './postEvent/ResultsContextCard';
import { ReviewChecklistCard } from './postEvent/ReviewChecklistCard';
import { ReviewGroundingCard } from './postEvent/ReviewGroundingCard';
import { PostEventSynthesisCard } from './postEventPaid/PostEventSynthesisCard';

function NotFoundState() {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-center gap-4 py-16 text-center">
      <h1 className="text-2xl font-semibold tracking-tight">{t('tournaments.notFound.title')}</h1>
      <p className="max-w-md text-muted-foreground">{t('tournaments.notFound.body')}</p>
      <Button asChild className="mt-2">
        <Link to="/trends">{t('tournaments.notFound.back')}</Link>
      </Button>
    </div>
  );
}

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
 */
type PrepSurfaceMode = 'prep' | 'review';

function derivePrepSurfaceMode(status: PrepBriefStatus): PrepSurfaceMode {
  return status.activated && status.reviewAt !== undefined && status.reviewAt <= Date.now()
    ? 'review'
    : 'prep';
}

/**
 * Phase 26 (PREP-01/02/04, D-03/D-08/D-12/D-13/D-15): the free deterministic
 * tournament prep brief at `/tournaments/:entryKey/prep`. The route's param
 * is honestly named `entryKey` (D-13) — the sibling detail route's legacy
 * param label was left untouched.
 *
 * Mount-time activate-or-reopen (D-12, RESEARCH Assumption A2, approved):
 * once the brief-status query resolves, this page fires exactly one mutation
 * for the lifetime of the mount — activate when no brief exists yet, reopen
 * (carrying this mount's stable open id) when one already does — guarded by
 * a ref so a re-render or a query refetch can never re-fire it. Neither
 * mutation is awaited before rendering: the brief's content comes from the
 * already-resolved query, and the reopen call is bookkeeping, not a data
 * dependency (RESEARCH Open Question 2). This is also why activation lives
 * here rather than on the TournamentDetailPage CTA's click handler — it is
 * the only arrangement that keeps that CTA a plain navigation `Link` while
 * still honouring "a GET never writes" (D-12).
 *
 * An activated brief renders even when its `eventDate` has already passed —
 * no date gate exists on this page (D-03). "Hide expired briefs" is the
 * plausible-sounding change that would break Phase 28's conversion of this
 * same URL into the post-event review surface; do not add one.
 */
export function PrepBriefPage() {
  const { t } = useTranslation();
  const { entryKey } = useParams<{ entryKey: string }>();

  const { data: entries, isLoading: entriesLoading } = useTournamentEntries();
  const { data: allMatches = [], isLoading: matchesLoading } = useMatches();
  const { data: aliasMap } = useOpponentAliases();
  const { data: canonicalOpponents = [] } = useOpponents();
  const { data: opponentNotes } = useOpponentNotes();

  const briefQuery = usePrepBrief(entryKey);
  const activateBrief = useActivatePrepBrief(entryKey ?? '');
  const reopenBrief = useReopenPrepBrief(entryKey ?? '');

  const entry = useMemo(() => {
    if (!entries || !entryKey) {
      return undefined;
    }
    return entries.find((e) => e.entryKey === entryKey);
  }, [entries, entryKey]);

  // All-time, all-source, alias-resolved match set — deliberately NOT
  // useFilteredMatches(), which would apply whatever source/time-range
  // filter the user last left active on the Dashboard, silently shrinking a
  // prep brief's head-to-head history out from under it (RESEARCH Pitfall 1).
  const matches = useMemo(
    () => applyOpponentAliases(allMatches, aliasMap ?? {}),
    [allMatches, aliasMap],
  );

  // WR-04: keyed by entryKey itself (not a bare boolean) so the guard is
  // entryKey-safe even if this exact component instance is ever kept
  // mounted across an entryKey change (React Router reuses the element
  // across param-only changes to the same route pattern — it does not
  // remount just because `useParams().entryKey` changes). A bare
  // `useRef(false)` would silently never fire again for a second entryKey
  // visited on an already-mounted instance; comparing against the fired
  // entryKey makes a genuine param change fire correctly.
  const firedForEntryKeyRef = useRef<string | undefined>(undefined);

  // Collapsed-prep section's open/closed state (28-UI-SPEC.md §1) —
  // deliberately ephemeral component state, not persisted, and not shared
  // with the prep-mode branch's own composition.
  const [prepSectionOpen, setPrepSectionOpen] = useState(false);

  useEffect(() => {
    if (!entryKey || briefQuery.isPending || briefQuery.isError) {
      return;
    }
    if (firedForEntryKeyRef.current === entryKey) {
      return;
    }
    firedForEntryKeyRef.current = entryKey;
    if (briefQuery.data.activated) {
      // A fresh open id per fire (not a mount-lifetime one) is what makes
      // this entryKey-safe: each distinct entryKey's reopen gets its own
      // id, exactly as a genuinely fresh mount would produce (D-08).
      reopenBrief.mutate(crypto.randomUUID());
    } else {
      activateBrief.mutate();
    }
    // Deliberately excludes `activateBrief`/`reopenBrief` from the
    // dependency list — the mutation objects are new on every render and
    // re-adding them would defeat the single-fire-per-entryKey guard above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entryKey, briefQuery.isPending, briefQuery.isError, briefQuery.data]);

  if (entriesLoading || matchesLoading || briefQuery.isPending) {
    return <div className="text-muted-foreground">{t('prep.loading')}</div>;
  }

  if (briefQuery.isError) {
    return <div className="text-muted-foreground">{t('prep.error.loadFailed')}</div>;
  }

  if (!entry) {
    return <NotFoundState />;
  }

  // The mode switch reads ONLY `briefQuery.data.reviewAt` (owner invariant
  // 5) — never `entry.eventDate`/`firstSetAt`/`lastSetAt`. It is computed
  // here, after the pending/error guards above, so `briefQuery.data` is
  // guaranteed present.
  const mode: PrepSurfaceMode = derivePrepSurfaceMode(briefQuery.data);

  const brief = briefQuery.data.brief;
  const likelyOpponents = brief?.likelyOpponents ?? {};
  const checklist = brief?.checklist ?? {};
  const scoutBindings = brief?.scoutBindings ?? {};
  const reviewChecklist = brief?.reviewChecklist ?? {};

  // Review-mode-only derivations (REV-01/REV-02): computed only when the
  // review branch will actually render, since `selectReviewResultsContext`/
  // `matchesForEntry` are meaningless outside review mode and the prep
  // branch must stay byte-identical to Phase 27.
  const reviewResults =
    mode === 'review'
      ? selectReviewResultsContext(matches, entry, likelyOpponents)
      : { synced: [], manual: [] };
  const eventMatches = mode === 'review' ? matchesForEntry(matches, entry) : [];
  // The client mirror of the server's 409 no-evidence precondition — the
  // SAME "has any VOD timestamp or tag" rule `ReviewGroundingCard` uses to
  // decide which matches count as grounded, computed once here so the page
  // stays the single source `PostEventSynthesisCard` (28-09) reads from
  // (that card never re-derives this count itself).
  const annotatedEvidenceCount = eventMatches.filter(
    (match) => (match.vodTimestamps?.length ?? 0) > 0 || (match.tags?.length ?? 0) > 0,
  ).length;

  // RPT-04: a strict boolean-true comparison, never a truthiness check — an
  // absent/undefined field from an older or gate-off server, or any
  // non-boolean value, must never render the paid card. This is the ONLY
  // condition that decides the card's presence: deliberately no second
  // clause such as "or this brief already has jobs", because a second
  // condition would mean the card's mount is no longer a PURE function of
  // the server's answer, which is exactly the structural guarantee that
  // makes turning the gate off make the placement vanish. A mid-session
  // flip-off therefore hides the placement while the underlying work stays
  // untouched — refunds still complete server-side and a generated report
  // remains reachable through the ungated report list (27-UI-SPEC.md
  // "Structural Absence Contract").
  const showPaidReports = briefQuery.data.paidReportsAvailable === true;

  return (
    <div className="flex flex-col gap-6">
      <TournamentHeader entry={entry} />
      {mode === 'prep' && (
        <>
          <LikelyOpponentsCard
            entryKey={entryKey!}
            likelyOpponents={likelyOpponents}
            matches={matches}
            canonicalOpponents={canonicalOpponents}
            notes={opponentNotes ?? {}}
          />
          {showPaidReports && (
            <PrepPaidReportsCard
              entryKey={entryKey!}
              likelyOpponents={likelyOpponents}
              scoutBindings={scoutBindings}
            />
          )}
          <PrepChecklistCard entryKey={entryKey!} checklist={checklist} />
        </>
      )}
      {mode === 'review' && (
        <>
          <ReviewModeStrip />
          <ResultsContextCard synced={reviewResults.synced} manual={reviewResults.manual} />
          <ReviewChecklistCard entryKey={entryKey!} reviewChecklist={reviewChecklist} />
          <ReviewGroundingCard eventMatches={eventMatches} />
          {/*
           * RPT-04's exact strict-true rule, reused verbatim (owner
           * invariant 6 / REV-03): `showPaidReports` is the SAME
           * `paidReportsAvailable === true` field the prep branch's
           * `PrepPaidReportsCard` reads above — no second gate exists for
           * review mode. This is the ONE monetized surface review mode
           * mounts; `PrepPaidReportsCard` never re-renders here.
           */}
          {showPaidReports && (
            <PostEventSynthesisCard
              entryKey={entryKey!}
              annotatedEvidenceCount={annotatedEvidenceCount}
            />
          )}
          {/*
           * Collapsed-prep section (28-UI-SPEC.md §1, settled decision):
           * the UNCHANGED Phase 26 cards, fully functional, collapsed by
           * default. `PrepPaidReportsCard` is DELIBERATELY excluded here —
           * review mode's sole monetized placement is the synthesis card
           * above, keeping exactly one paid surface per mode. Prior prep
           * report purchases stay reachable through the existing ungated
           * reports list (27-UI-SPEC.md's established rule); flag any
           * desire to surface them here as a scope addition.
           */}
          <Collapsible open={prepSectionOpen} onOpenChange={setPrepSectionOpen}>
            <CollapsibleTrigger asChild>
              <button
                type="button"
                className="flex w-full items-center justify-between rounded-md border p-3 text-left"
              >
                <span className="flex items-center gap-2 text-sm font-medium">
                  {prepSectionOpen ? (
                    <ChevronDown className="size-4 text-muted-foreground" aria-hidden="true" />
                  ) : (
                    <ChevronRight className="size-4 text-muted-foreground" aria-hidden="true" />
                  )}
                  {t('postEvent.prepSection.trigger')}
                </span>
                <span className="text-xs text-muted-foreground">
                  {t('postEvent.prepSection.hint')}
                </span>
              </button>
            </CollapsibleTrigger>
            <CollapsibleContent className="flex flex-col gap-6 pt-6">
              <LikelyOpponentsCard
                entryKey={entryKey!}
                likelyOpponents={likelyOpponents}
                matches={matches}
                canonicalOpponents={canonicalOpponents}
                notes={opponentNotes ?? {}}
              />
              <PrepChecklistCard entryKey={entryKey!} checklist={checklist} />
            </CollapsibleContent>
          </Collapsible>
        </>
      )}
    </div>
  );
}
