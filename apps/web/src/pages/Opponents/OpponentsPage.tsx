import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { resolveAliasChain } from '@smash-tracker/shared';
import { Button } from '@/components/ui/button';
import {
  ANALYZE_OPPONENT_PLAYER_PARAM,
  ANALYZE_OPPONENT_TAG_PARAM,
  buildOpponentHubPath,
  resolveAnalyzeOpponentPreselection,
} from '@/lib/analyzeOpponent';
import { getOpponentSources, useFilteredMatches } from '@/hooks/useFilteredMatches';
import { useTournamentEntries } from '@/hooks/useTournamentEntries';
import { useOpponentAliases } from '@/hooks/useOpponentAliases';
import { useOpponentNotes } from '@/hooks/useOpponentNotes';
import { useAuth } from '@/hooks/useAuth';
import { FilteredEmptyNotice } from '@/components/FilteredEmptyNotice';
import {
  buildOpponentEvidence,
  buildOpponentProfile,
  resolveOpponentIdentities,
} from '@/lib/stats';
import { OpponentList } from './components/OpponentList';
import { ScoutingHeader } from './components/ScoutingHeader';
import { WhatTheyPlayTable } from './components/WhatTheyPlayTable';
import { ScoutingStagesCard } from './components/ScoutingStagesCard';
import { ScoutingTrendChart } from './components/ScoutingTrendChart';
import { RecentEncounters } from './components/RecentEncounters';
import { TournamentHistory } from './components/TournamentHistory';
import { MergeOpponentDialog } from './components/MergeOpponentDialog';
import { MergedNamesCard } from './components/MergedNamesCard';
import { TendenciesCard } from './components/TendenciesCard';
import { ExportH2HButton } from './components/ExportH2HButton';
import { PrintableEvidencePacket } from './components/PrintableEvidencePacket';
import { groupTournamentBlocks, getEncounterContext } from './tournamentHistory';
import { buildEvidencePacket } from './evidencePacket';

/**
 * Phase E (docs/analytics-vision.md): scouting reports per human opponent —
 * H2H record + timeline, what they play against you, stages they take you
 * to, and recent encounters. Searchable list ranked by games played.
 */
export function OpponentsPage() {
  const { t } = useTranslation();
  const { matches, allMatches, isLoading, filterActive } = useFilteredMatches();
  const { data: tournamentEntries } = useTournamentEntries();
  const { data: aliasMap } = useOpponentAliases();
  const { data: noteMap } = useOpponentNotes();
  const { user } = useAuth();
  // React Compiler forbids a bare `Date.now()` call in the render body (it's
  // impure) — a lazy `useState` initializer is the sanctioned one-time-read
  // escape hatch, matching `CounterpickAdvisor.tsx`'s convention. One value
  // per render pass, shared by every `buildOpponentEvidence`/
  // `buildOpponentProfile` call below, so all three claims report the same
  // refresh time.
  const [refreshedAt] = useState(() => Date.now());

  // Phase 36 (EVID-12, R1-BLOCKER-2): the identity-resolving inventory
  // (aliased + normalized + slug/parry-id bound), NOT the raw-tag
  // `getOpponentRecords` — one alias-merged person is now ONE row here.
  const opponentRecords = useMemo(
    () => buildOpponentEvidence({ matches, aliasMap: aliasMap ?? {}, refreshedAt }).rows,
    [matches, aliasMap, refreshedAt],
  );
  const sources = useMemo(() => getOpponentSources(matches), [matches]);

  const mostPlayed = useMemo(() => {
    return [...opponentRecords].sort((a, b) => b.total - a.total)[0]?.displayTag ?? null;
  }, [opponentRecords]);

  // Tracks an explicit user selection only; when unset, or when the previous
  // selection has dropped out of the filtered set (e.g. the global
  // source/time filter changed), the most-played opponent is used instead —
  // derived during render like Dashboard's fighter selection, no effect
  // needed to seed state from data that just loaded.
  const [selectedOpponent, setSelectedOpponent] = useState<string | null>(null);

  // Plan 38-05 (D-01/D-02): "Analyze opponent" deep links with
  // ?player=sgg:<slug>|pgg:<id> and/or ?opponent=<tag> now REDIRECT into the
  // hub (below) instead of preselecting inline — the hub is the addressable
  // surface these links resolve into. `player=` is carried through verbatim
  // (D-02 keeps it alive as a provider-identity hint the hub consumes as an
  // identity fallback of last resort, never a filter axis).
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  useEffect(() => {
    const opponentParam = searchParams.get(ANALYZE_OPPONENT_TAG_PARAM);
    const playerParam = searchParams.get(ANALYZE_OPPONENT_PLAYER_PARAM);
    if (!opponentParam && !playerParam) {
      return;
    }
    // Wait for BOTH queries to settle before resolving: a provider-id or
    // alias hint resolved against a still-empty `matches`/`aliasMap` (the
    // initial render, before either query has loaded) would redirect to the
    // WRONG tag and, because this component then unmounts, never gets a
    // chance to correct itself once the real data arrives. `aliasMap` is
    // checked for definedness rather than the query's own `isLoading` flag —
    // a disabled query (auth still resolving) reports `isLoading: false`
    // with `data: undefined`, which would pass a naive `isLoading` check.
    if (isLoading || aliasMap === undefined) {
      return;
    }
    const resolved = resolveAnalyzeOpponentPreselection(searchParams, matches, aliasMap ?? {});
    if (!resolved) {
      // A hint that resolves to nothing falls through to today's behaviour
      // (the list with no selection) rather than redirecting to a dead hub.
      return;
    }
    const hubSearch = playerParam
      ? `?${ANALYZE_OPPONENT_PLAYER_PARAM}=${encodeURIComponent(playerParam)}`
      : '';
    navigate(`${buildOpponentHubPath(resolved)}${hubSearch}`, { replace: true });
  }, [searchParams, matches, aliasMap, isLoading, navigate]);

  // The opponent name currently open in the "Merge into..." dialog, or null
  // when the dialog is closed.
  const [mergeCandidate, setMergeCandidate] = useState<string | null>(null);

  const requested = selectedOpponent;
  const selected =
    requested && opponentRecords.some((o) => o.displayTag === requested) ? requested : mostPlayed;

  const profile = useMemo(() => {
    if (!selected) {
      return null;
    }
    return buildOpponentProfile({
      matches,
      aliasMap: aliasMap ?? {},
      opponentTag: selected,
      refreshedAt,
    });
  }, [matches, aliasMap, selected, refreshedAt]);

  // Phase 36 (EVID-12): resolved-identity comparison, not raw-string
  // equality — an alias-merged person's drill-down series must interleave
  // ALL of their tags' games into one continuous chronological run, which a
  // `m.opponent === profile.opponent` comparison (a normalized canonical
  // tag, post-migration) would silently re-split.
  const opponentMatches = useMemo(() => {
    if (!profile || !selected) {
      return [];
    }
    const resolve = resolveOpponentIdentities(matches, aliasMap ?? {});
    const targetIdentity = resolve({ opponent: selected });
    return matches.filter((m) => resolve(m) === targetIdentity);
  }, [matches, aliasMap, profile, selected]);

  const tournamentBlocks = useMemo(() => groupTournamentBlocks(opponentMatches), [opponentMatches]);

  const encounterContext = useMemo(() => getEncounterContext(tournamentBlocks), [tournamentBlocks]);

  // Alias names that currently resolve to the selected opponent (for the
  // "Merged names" management card). WR-02-i2: follows the FULL transitive
  // chain via `resolveAliasChain` (the same shared primitive CR-01 made the
  // canonical resolver) rather than a reverse single-hop `canonical ===
  // selected` lookup — for a chain like `{ leo: 'mkleo', mkleo:
  // 'somebody-else' }` with `selected === 'somebody-else'`, a single-hop
  // filter lists only `'mkleo'` and silently omits `'leo'`, even though
  // `'leo'`'s matches are already correctly folded into this same row by
  // CR-01's fix.
  const mergedAliasesForSelected = useMemo(() => {
    if (!selected || !aliasMap) {
      return [];
    }
    return Object.keys(aliasMap).filter((alias) => resolveAliasChain(alias, aliasMap) === selected);
  }, [aliasMap, selected]);

  // V6-W1c: "Export H2H" evidence packet — built from the same profile +
  // tournament blocks already computed for the report, so print/copy can
  // never disagree with what's on screen.
  const evidencePacket = useMemo(() => {
    if (!profile) {
      return null;
    }
    return buildEvidencePacket(profile, tournamentBlocks, user?.email ?? 'you');
  }, [profile, tournamentBlocks, user]);

  if (isLoading) {
    return (
      <div className="flex flex-col gap-6">
        <div className="text-muted-foreground">{t('opponents.loading')}</div>
      </div>
    );
  }

  if (allMatches.length === 0) {
    return (
      <div className="flex flex-col gap-6">
        <div className="flex flex-col items-center gap-4 py-16 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">{t('opponents.empty.title')}</h1>
          <p className="max-w-md text-muted-foreground">{t('opponents.empty.body')}</p>
          <div className="flex flex-wrap justify-center gap-2">
            <Button asChild>
              <Link to="/dashboard">{t('common.goToDashboard')}</Link>
            </Button>
            <Button asChild variant="outline">
              <Link to="/settings/integrations">{t('opponents.empty.connectStartgg')}</Link>
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // Phase 36 (R1-BLOCKER-2): a direct existence check, NOT the identity
  // engine — this branch decides whether to show the "no tags yet" empty
  // state, and it is not itself a claim about a specific person. Gating it
  // through `buildOpponentEvidence` (or the old `getOpponentRecords`) would
  // apply logic irrelevant to this yes/no question; a `.some(...)` over a
  // non-empty `opponent` is exactly what the branch asks.
  const hasNamedOpponent = allMatches.some((m) => m.opponent && m.opponent.length > 0);
  if (!hasNamedOpponent) {
    return (
      <div className="flex flex-col gap-6">
        <div className="flex flex-col items-center gap-2 py-16 text-center">
          <h2 className="text-xl font-semibold tracking-tight">{t('opponents.noTags.title')}</h2>
          <p className="max-w-md text-muted-foreground">{t('opponents.noTags.body')}</p>
          <Button asChild className="mt-2">
            <Link to="/dashboard">{t('common.goToDashboard')}</Link>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {filterActive && matches.length === 0 && <FilteredEmptyNotice />}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[320px_1fr]">
        <OpponentList
          matches={matches}
          selected={selected}
          onSelect={setSelectedOpponent}
          onRequestMerge={setMergeCandidate}
          aliasMap={aliasMap ?? {}}
        />

        {profile ? (
          <div key={profile.opponent} className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center justify-end gap-2 print:hidden">
              {evidencePacket && <ExportH2HButton packet={evidencePacket} />}
            </div>
            <ScoutingHeader
              profile={profile}
              encounterContext={encounterContext}
              source={profile.source}
            />
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <WhatTheyPlayTable byTheirFighter={profile.byTheirFighter} />
              <ScoutingStagesCard byStage={profile.byStage} />
            </div>
            <ScoutingTrendChart matches={opponentMatches} />
            <RecentEncounters matches={profile.recent} />
            <TournamentHistory
              blocks={tournamentBlocks}
              tournamentEntries={tournamentEntries ?? []}
            />
            <TendenciesCard opponent={profile.opponent} note={noteMap?.[profile.opponent]} />
            <MergedNamesCard canonical={profile.opponent} aliases={mergedAliasesForSelected} />
            {evidencePacket && <PrintableEvidencePacket packet={evidencePacket} />}
          </div>
        ) : (
          <div className="flex items-center justify-center rounded-lg border border-dashed p-16 text-center text-sm text-muted-foreground">
            {t('opponents.selectPrompt')}
          </div>
        )}
      </div>

      {mergeCandidate && (
        <MergeOpponentDialog
          open={mergeCandidate != null}
          onOpenChange={(open) => {
            if (!open) {
              setMergeCandidate(null);
            }
          }}
          opponent={mergeCandidate}
          candidates={opponentRecords
            .map((o) => o.displayTag)
            .filter((name) => name !== mergeCandidate)}
          sources={sources}
          onMerged={() => setMergeCandidate(null)}
        />
      )}
    </div>
  );
}
