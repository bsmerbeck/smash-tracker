import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { getOpponentSources, useFilteredMatches } from '@/hooks/useFilteredMatches';
import { useTournamentEntries } from '@/hooks/useTournamentEntries';
import { useOpponentAliases } from '@/hooks/useOpponentAliases';
import { useOpponentNotes } from '@/hooks/useOpponentNotes';
import { useAuth } from '@/hooks/useAuth';
import { FilteredEmptyNotice } from '@/components/FilteredEmptyNotice';
import { getOpponentProfile, getOpponentRecords } from '@/lib/stats';
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

  const opponentRecords = useMemo(() => getOpponentRecords(matches), [matches]);
  const sources = useMemo(() => getOpponentSources(matches), [matches]);

  const mostPlayed = useMemo(() => {
    return [...opponentRecords].sort((a, b) => b.total - a.total)[0]?.opponent ?? null;
  }, [opponentRecords]);

  // Tracks an explicit user selection only; when unset, or when the previous
  // selection has dropped out of the filtered set (e.g. the global
  // source/time filter changed), the most-played opponent is used instead —
  // derived during render like Dashboard's fighter selection, no effect
  // needed to seed state from data that just loaded.
  const [selectedOpponent, setSelectedOpponent] = useState<string | null>(null);

  // The opponent name currently open in the "Merge into..." dialog, or null
  // when the dialog is closed.
  const [mergeCandidate, setMergeCandidate] = useState<string | null>(null);

  const selected =
    selectedOpponent && opponentRecords.some((o) => o.opponent === selectedOpponent)
      ? selectedOpponent
      : mostPlayed;

  const profile = useMemo(() => {
    if (!selected) {
      return null;
    }
    return getOpponentProfile(matches, selected);
  }, [matches, selected]);

  const opponentMatches = useMemo(
    () => (profile ? matches.filter((m) => m.opponent === profile.opponent) : []),
    [matches, profile],
  );

  const tournamentBlocks = useMemo(() => groupTournamentBlocks(opponentMatches), [opponentMatches]);

  const encounterContext = useMemo(() => getEncounterContext(tournamentBlocks), [tournamentBlocks]);

  // Alias names that currently resolve to the selected opponent (for the
  // "Merged names" management card).
  const mergedAliasesForSelected = useMemo(() => {
    if (!selected || !aliasMap) {
      return [];
    }
    return Object.entries(aliasMap)
      .filter(([, canonical]) => canonical === selected)
      .map(([alias]) => alias);
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
    return <div className="text-muted-foreground">{t('opponents.loading')}</div>;
  }

  if (allMatches.length === 0) {
    return (
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
    );
  }

  const allOpponentsNamed = getOpponentRecords(allMatches);
  if (allOpponentsNamed.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-16 text-center">
        <h2 className="text-xl font-semibold tracking-tight">{t('opponents.noTags.title')}</h2>
        <p className="max-w-md text-muted-foreground">{t('opponents.noTags.body')}</p>
        <Button asChild className="mt-2">
          <Link to="/dashboard">{t('common.goToDashboard')}</Link>
        </Button>
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
        />

        {profile ? (
          <div key={profile.opponent} className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center justify-end gap-2 print:hidden">
              {evidencePacket && <ExportH2HButton packet={evidencePacket} />}
            </div>
            <ScoutingHeader
              profile={profile}
              encounterContext={encounterContext}
              source={sources.get(profile.opponent) ?? 'manual'}
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
            .map((o) => o.opponent)
            .filter((name) => name !== mergeCandidate)}
          sources={sources}
          onMerged={() => setMergeCandidate(null)}
        />
      )}
    </div>
  );
}
