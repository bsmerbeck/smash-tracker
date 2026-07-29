import { useEffect, useMemo, useRef } from 'react';
import { useParams, Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
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
 * Phase 28 will add a `'review'` branch here once an activated brief's event
 * date has passed — the page's render is already structured as a switch on
 * this single value so that phase adds a branch instead of restructuring the
 * page (26-UI-SPEC.md "Structural Notes for Future Phases"). Only the
 * derivation point exists in this phase; no review UI is implemented,
 * stubbed, or reserved.
 */
type PrepSurfaceMode = 'prep';

function derivePrepSurfaceMode(): PrepSurfaceMode {
  return 'prep';
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

  const mode: PrepSurfaceMode = derivePrepSurfaceMode();

  if (entriesLoading || matchesLoading || briefQuery.isPending) {
    return <div className="text-muted-foreground">{t('prep.loading')}</div>;
  }

  if (briefQuery.isError) {
    return <div className="text-muted-foreground">{t('prep.error.loadFailed')}</div>;
  }

  if (!entry) {
    return <NotFoundState />;
  }

  const brief = briefQuery.data.brief;
  const likelyOpponents = brief?.likelyOpponents ?? {};
  const checklist = brief?.checklist ?? {};

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
          <PrepChecklistCard entryKey={entryKey!} checklist={checklist} />
        </>
      )}
    </div>
  );
}
